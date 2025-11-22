import {DynamoDBClient, PutItemCommand, ScanCommand} from "@aws-sdk/client-dynamodb";
import fs from 'fs';
import  path from 'path';

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
 * Invoke SageMaker endpoint
 */
/**
 * Invoke Lambda via API Gateway instead of SageMaker directly
 */
async function invokeModelEndpoint(assignmentText, assignmentId, analyticsId) {
  try {
    console.log(`Calling Lambda for assignment ${assignmentId}`);

    const payload = {
      assignmentText,
      assignmentId,
      analyticsId
    };

    console.log("Payload being sent to Lambda:", payload);

    const response = await fetch("https://ph7qz98inj.execute-api.us-east-1.amazonaws.com/aithentic/sagemaker", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    console.log("Lambda raw response:", text);

    if (!response.ok) {
      throw new Error(`Lambda returned HTTP ${response.status}: ${text}`);
    }

    const parsed = JSON.parse(text);
    console.log("Final parsed model result:", parsed);

    return parsed;

  } catch (error) {
    console.error("Lambda invocation error:", error);
    throw error;
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
        const modelResult = await invokeModelEndpoint(assignmentText, assignmentId, maxId);

        validateDynamoDBStructure(modelResult);

        // const modelResult = {
        //   "analyticsId": {"N": "12345"},
        //   "assignmentId": {"N": assignmentId},
        //   "gradeReceived": {"N": "85"},
        //   "aiGeneratedAnalytics": {"M": {
        //     "isAIUsed": {"BOOL": true},
        //     "percentageOfAIUsed": {"N": "60"},
        //     "highlightedAreaOfAIUse": {"L": [
        //       {"S": "10"},
        //       {"S": "25"}
        //     ]}
        //   }},
        //   "plagarismAnalytics": {"M": {
        //     "isPlagarised": {"BOOL": false},
        //     "plagarisedPercentage": {"N": "0"},
        //     "plagarisedFrom": {"L": []}
        //   }},
        //   "gradeReasoning": {"S": "The assignment shows significant AI-generated content, leading to deductions."},
        //   "remarks": {"S": "Please ensure more original work in future submissions."}
        // };

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