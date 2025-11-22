import {DynamoDBClient, PutItemCommand, ScanCommand} from "@aws-sdk/client-dynamodb";
import fs from 'fs';
import  path from 'path';
import axios from 'axios';

// Initialize AWS clients
const dynamodb = new DynamoDBClient({ region: 'us-east-1' });

const fsp = fs.promises;

const CONFIG = {
  DYNAMODB_TABLE: 'assignment_analysis_data',
  REGION: 'us-east-1',
  LOCAL_CONVERTED_DIR: './converted'
};


/**
 * Read assignment from local EC2 /converted directory
 */
async function readAssignmentFromLocal(filename) {
  const fullPath = path.join(CONFIG.LOCAL_CONVERTED_DIR, filename);

  try {
    const assignmentText = await fsp.readFile(fullPath, 'utf8');
    const assignmentId = filename.replace(path.extname(filename), '');
    console.log(`Loaded: ${filename}`);
    return { assignmentText, assignmentId };
  } catch (error) {
    throw new Error(`Failed to read file ${fullPath}: ${error.message}`);
  }
}

/**
 * Invoke Lambda via API Gateway instead of SageMaker directly
 */
function sanitizeText(text) {
  return text
    .replace(/\u0000/g, '')      // remove null bytes
    .replace(/\f/g, '\n')        // convert form-feed to newline
    .replace(/\r/g, '\n')        // normalize CR
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xa0-\uFFFF]/g, ''); // remove weird control chars
}
/**
 * Convert text into a single-line JSON-safe string
 */
function normalizeForOneLine(text) {
  return text
    .replace(/\u0000/g, '')
    .replace(/\f/g, ' ')
    .replace(/\r\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/\s\s+/g, ' ')   // collapse multiple spaces
    .trim();
}

async function invokeModelEndpoint(assignmentText, assignmentId, analyticsId) {
  const MAX_RETRIES = 3;
  const TIMEOUT_MS = 60000; // 60 second timeout
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const cleaned = sanitizeText(assignmentText);
      const oneLineText = normalizeForOneLine(cleaned);
      const safeText = `<<RAW_TEXT_START>>${oneLineText}<<RAW_TEXT_END>>`;

      console.log(`[Attempt ${attempt}/${MAX_RETRIES}] Calling Lambda for assignment (length: ${safeText.length})`);

      const payload = {
        assignmentText: safeText,
        assignmentId,
        analyticsId
      };

      console.log("Payload being sent to Lambda:", payload);

      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await axios.post(
          "https://ph7qz98inj.execute-api.us-east-1.amazonaws.com/aithentic/sagemaker",
          payload,
          {
            headers: {
              "Content-Type": "application/json"
            },
            timeout: TIMEOUT_MS
          }
        );

        clearTimeout(timeoutId);
        console.log("Lambda HTTP status:", response.status);
        const raw = response.data;
        console.log("Lambda raw response:", JSON.stringify(raw).substring(0, 500)); // Log first 500 chars

        // Check for HTTP error status
        if (response.status >= 400) {
          throw new Error(`Lambda returned HTTP ${response.status}: ${JSON.stringify(raw)}`);
        }

        let parsed;

        try {
          // Parse the response (axios auto-parses JSON, so raw is already an object)
          const result = typeof raw === 'string' ? JSON.parse(raw) : raw;

          // Check if it's the new format (direct DynamoDB JSON with N, S, M fields)
          if (result.analyticsId && result.analyticsId.N !== undefined) {
            console.log("Detected DynamoDB format response");
            parsed = result; // Already in the correct format for DynamoDB
          } 
          // Check if it's the old SageMaker array format
          else if (Array.isArray(result) && result.length > 0 && result[0].generated_text) {
            console.log("Detected SageMaker array format response");
            parsed = JSON.parse(result[0].generated_text);
          } 
          else {
            throw new Error(`Unknown response format. Expected DynamoDB JSON or SageMaker array. Got: ${JSON.stringify(result).substring(0, 200)}`);
          }

        } catch (parseErr) {
          console.error("Failed to parse Lambda output:", parseErr.message);
          console.error("RAW response was:", JSON.stringify(raw).substring(0, 500));
          throw parseErr;
        }

        console.log("Final parsed model result:", parsed);
        return parsed;

      } finally {
        clearTimeout(timeoutId);
      }

    } catch (error) {
      console.error(`[Attempt ${attempt}/${MAX_RETRIES}] Lambda invocation error:`, error.message);

      // If it's a 502 or timeout, retry
      if (attempt < MAX_RETRIES && (error.response?.status === 502 || error.code === 'ECONNABORTED')) {
        const backoffMs = 1000 * attempt; // 1s, 2s, 3s
        console.log(`Retrying in ${backoffMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }

      // If this is the last attempt, throw
      if (attempt === MAX_RETRIES) {
        throw new Error(`Lambda invocation failed after ${MAX_RETRIES} attempts: ${error.message}`);
      }

      throw error;
    }
  }
}

/**
 * Validate DynamoDB JSON
 */
function validateDynamoDBStructure(result) {
  const required = [
    'analyticsId',
    'assignmentId',
    'gradeReceived',
    'aiGeneratedAnalytics',
    'plagarismAnalytics',
    'gradeReasoning',
    'remarks'
  ];

  required.forEach((field) => {
    if (!result[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  });

  return true;
}

/**
 * Save one result to DynamoDB
 */
async function saveAnalysisToDynamoDB(result) {

  await dynamodb.send(new PutItemCommand({
    TableName: CONFIG.DYNAMODB_TABLE,
    Item: result
    }));

  console.log(`Saved to DynamoDB: assignmentId ${result.assignmentId.N}`);
}

function convert(item) {
    if (!item) return null;

    const out = {};
    for (const key in item) {
        const val = item[key];

        if (val.S !== undefined) out[key] = val.S;
        else if (val.N !== undefined) out[key] = Number(val.N);
        else if (val.BOOL !== undefined) out[key] = val.BOOL;
        else if (val.M !== undefined) out[key] = convert(val.M);
        else if (val.L !== undefined) out[key] = val.L.map(convert);
        else out[key] = val;
    }
    return out;
}

/**
 * Main handler — processes ALL files in /converted folder
 */
export async function handler(event, context) {
  console.log('Starting batch assignment analysis...');

  const command = new ScanCommand({
      TableName: "assignment_analysis_data"
  });

  const raw = await dynamodb.send(command);

  // Convert all rows to normal JS
  const allAssignments = raw.Items.map(item => convert(item));

  // Find the highest numeric analyticsId
  let maxId = -Infinity;
  for (const a of allAssignments) {
    const id = Number(a.analyticsId);
    if (!Number.isNaN(id) && id > maxId) maxId = id;
  }

  console.log('Highest analyticsId found:', maxId);

  try {
    const files = await fsp.readdir(CONFIG.LOCAL_CONVERTED_DIR);
    const txtFiles = files.filter(f => f.endsWith('.txt'));

    if (txtFiles.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'No converted files found.' })
      };
    }

    console.log(`Found ${txtFiles.length} files to process`);

    const results = [];

    for (const file of txtFiles) {
      try {
        console.log(`\n--- Processing ${file} ---`);
        const { assignmentText, assignmentId } = await readAssignmentFromLocal(file);
        if(isNaN(Number(assignmentId))) continue;
        const modelResult = await invokeModelEndpoint(assignmentText, assignmentId, maxId+1);

        // validateDynamoDBStructure(modelResult);

        try {
          await saveAnalysisToDynamoDB(modelResult);

          results.push({
            assignmentId,
            status: 'SUCCESS'
          });
        } catch (saveErr) {
          console.error(`DynamoDB save failed for ${assignmentId}:`, saveErr.message || saveErr);
          results.push({
            assignmentId,
            status: 'FAILED',
            error: (saveErr && saveErr.message) || String(saveErr)
          });
        }

      } catch (error) {
        console.error(`Error processing ${file}:`, error.message);

        results.push({
          assignmentId: file.replace('.txt', ''),
          status: 'FAILED',
          error: error.message
        });
      }
    }

    console.log('Batch processing complete.');

    return {
      statusCode: 200,
      body: JSON.stringify(results, null, 2)
    };
  } catch (error) {
    console.error('Handler error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
}

handler();
// Export helpers for testing
export {
  readAssignmentFromLocal,
  invokeModelEndpoint,
  saveAnalysisToDynamoDB,
  validateDynamoDBStructure
};