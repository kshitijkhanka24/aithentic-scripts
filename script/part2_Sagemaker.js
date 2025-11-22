import {DynamoDBClient, PutItemCommand, ScanCommand} from "@aws-sdk/client-dynamodb";
import {SageMakerRuntimeClient, InvokeEndpointCommand} from "@aws-sdk/client-sagemaker-runtime";
import fs from 'fs';
import  path from 'path';

// Initialize AWS clients
const dynamodb = new DynamoDBClient({ region: 'us-east-1' });
const sagemakerRuntime = new SageMakerRuntimeClient({ region: 'us-east-1' });

const fsp = fs.promises;

const CONFIG = {
  DYNAMODB_TABLE: 'assignment_analysis_data',
  SAGEMAKER_ENDPOINT: 'aithentic-kmeans-endpoint',
  REGION: 'us-east-1',
  LOCAL_CONVERTED_DIR: './converted'
};

const SYSTEM_PROMPT = `You are an academic integrity evaluator.

You will receive:
1. The full assignment content (raw text).
2. assignmentId → extracted from the filename (string without extension).
3. analyticsId → for now always “12345”.

These are injected into the prompt automatically by the calling application.

Your job:
Analyze the assignment for plagiarism and AI-generated content, calculate deductions, and respond ONLY with a DynamoDB-compatible JSON object in the exact structure below.

--------------------------
DECISION RULES
--------------------------
• Use the provided analyticsId (N) and assignmentId (N) in the output JSON.

• PLAGIARISM DEDUCTIONS
  - If plagiarism ≥ 85% → gradeReceived = 0
  - If plagiarism ≥ 70% → subtract 30 points
  - If plagiarism ≥ 50% → subtract 20 points

• AI-GENERATED CONTENT DEDUCTIONS
  - If AI ≥ 90% → gradeReceived = 0
  - If AI ≥ 70% → subtract 30 points
  - If AI ≥ 50% → subtract 15 points

• QUALITY FLAGS
  - “Minor scope of improvement” → gradeReceived = 95
  - “Major scope of improvement” → gradeReceived = 85

• If content is fully correct with no deductions → gradeReceived = 100.

• Output whether AI was used (BOOL) and % AI used.
  Include a list of **starting paragraph line numbers** where AI-generated content appears.

• Output whether plagiarism occurred (BOOL) and % plagiarised.
  Include a list of **starting line numbers** where plagiarism was detected.

• Provide:
  - gradeReasoning → max 60 words
  - remarks → max 60 words

• Include 4-5 specific suspicious-looking words from the assignment that seem AI-generated.

--------------------------
OUTPUT FORMAT (MANDATORY)
--------------------------
Reply ONLY with a DynamoDB-compatible JSON object using this exact structure:

{
  "analyticsId": {"N": "<analyticsId>"},
  "assignmentId": {"N": "<assignmentId>"},
  "gradeReceived": {"N": "<grade>"},

  "aiGeneratedAnalytics": {"M": {
    "isAIUsed": {"BOOL": <true/false>},
    "percentageOfAIUsed": {"N": "<percent>"},
    "highlightedAreaOfAIUse": {"L": [
      {"S": "<starting line of AI paragraph>"},
      {"S": "<starting line of another AI paragraph>"}
    ]}
  }},

  "plagarismAnalytics": {"M": {
    "isPlagarised": {"BOOL": <true/false>},
    "plagarisedPercentage": {"N": "<percent>"},
    "plagarisedFrom": {"L": [
      {"S": "<starting line of plagiarised section>"},
      {"S": "<starting line of another plagiarised section>"}
    ]}
  }},

  "gradeReasoning": {"S": "<≤60 words>"},
  "remarks": {"S": "<≤60 words>"}
}

You must always respond with valid DynamoDB JSON. No extra text, no markdown.
`;

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
async function invokeModelEndpoint(assignmentText, assignmentId, analyticsId) {
  try {
    console.log(`Invoking SageMaker for assignmentId: ${assignmentId} with analyticsId: ${analyticsId}`);
    console.log(`Assignment text length: ${assignmentText.length} characters`);

    const payload = {
      prompt: SYSTEM_PROMPT,
      assignment_content: assignmentText,
      assignment_id: assignmentId,
      analytics_id: analyticsId
    };

    console.log(`Payload size: ${JSON.stringify(payload).length} bytes`);

    const command = new InvokeEndpointCommand({
      EndpointName: CONFIG.SAGEMAKER_ENDPOINT,
      Body: JSON.stringify(payload),
      ContentType: "application/json",
      Accept: "application/json"
    });

    const response = await sagemakerRuntime.send(command);

    // ⭐ THIS IS WHERE YOU PUT THE DECODE LINE
    const raw = new TextDecoder("utf-8").decode(response.Body);
    console.log("Raw SageMaker response:", raw);

    const parsed = JSON.parse(raw);
    return parsed;

  } catch (error) {
    console.error("SageMaker invocation error:", error);
    
    // Log more details for debugging
    if (error.$metadata) {
      console.error("HTTP Status Code:", error.$metadata.httpStatusCode);
      console.error("Request ID:", error.$metadata.requestId);
    }
    
    if (error.OriginalStatusCode) {
      console.error("Original Error Code:", error.OriginalStatusCode);
      console.error("Original Message:", error.OriginalMessage);
    }
    
    if (error.LogStreamArn) {
      console.error("CloudWatch Logs:", error.LogStreamArn);
    }
    
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

/**
 * TROUBLESHOOTING GUIDE FOR SAGEMAKER 500 ERRORS
 * 
 * If you see "ModelError: Received server error (500)", check:
 * 
 * 1. Endpoint Status:
 *    - AWS Console > SageMaker > Endpoints > aithentic-kmeans-endpoint
 *    - Ensure status is "InService" (not "Creating", "Failed", "Updating", etc.)
 * 
 * 2. CloudWatch Logs:
 *    - Check the log stream provided in the error message
 *    - Look for specific error messages from your model code
 * 
 * 3. Model Container Issues:
 *    - The inference container may have crashed or exited
 *    - Check if the Docker container is still running
 *    - Verify model artifacts are present in the container
 * 
 * 4. Payload Issues:
 *    - Ensure the request payload format matches the model's expectations
 *    - Check ContentType and Accept headers are correct (application/json)
 *    - Validate JSON payload doesn't have parsing errors
 * 
 * 5. Memory/Resource Issues:
 *    - The instance may be out of memory
 *    - Check instance type and available resources in CloudWatch
 *    - Consider upgrading to a larger instance type
 * 
 * 6. Endpoint Configuration:
 *    - Verify the endpoint is correctly configured for your model
 *    - Check environment variables are set in the container
 *    - Ensure dependencies are installed in the container
 * 
 * Next Steps:
 *    1. Check CloudWatch logs (link provided in error)
 *    2. Consider restarting the endpoint
 *    3. If logs show model errors, fix the model and redeploy
 *    4. Test with a simple payload first (e.g., small text)
 *
 */
