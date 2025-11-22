// Aithentic Assignment Grading System - Parts 1-5
// EC2 Instance Script for S3 Assignment Fetching and PDF Conversion
// Using AWS SDK v3

import { S3Client, ListObjectsV2Command, GetObjectCommand, HeadBucketCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Readable } from 'stream';

const fsp = fs.promises;

// Configure AWS SDK v3 - uses IAM role attached to EC2 instance
// Allow overriding region and bucket from environment variables for easier testing and debugging
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const s3Client = new S3Client({ region });

// Configuration (can be overridden via env vars)
const CONFIG = {
  bucketName: process.env.S3_BUCKET || process.env.ASSIGNMENTS_BUCKET || 'aithentic-assignment-bucket', // Replace with your S3 bucket name or set env var
  assignmentsFolder: process.env.ASSIGNMENTS_PREFIX || 'assignments/',
  convertedFolder: process.env.CONVERTED_PREFIX || 'converted/',
  localAssignmentsDir: './assignments',
  localConvertedDir: './converted'
};

/**
 * Helper function to convert stream to buffer
 */
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Main execution function
 */
async function main() {
  try {
    console.log('=== Aithentic Assignment Processing Started ===');
    console.log(`Timestamp: ${new Date().toISOString()}`);
    
    // Part 1-2: Setup and verify environment
    await setupEnvironment();
    
    // Part 3-4: Fetch all assignments from S3
    const pdfFiles = await fetchAssignmentsFromS3();
    console.log(`Found ${pdfFiles.length} PDF files to process`);
    
    // Part 5: Convert all PDFs to text
    await convertPDFsToText(pdfFiles);
    
    console.log('=== Parts 1-5 Completed Successfully ===');
    return true;
    
  } catch (error) {
    console.error('Error in main execution:', error);
    throw error;
  }
}

/**
 * Part 1-2: Setup local directories and verify AWS access
 */
async function setupEnvironment() {
  console.log('\n--- Setting Up Environment ---');
  
  try {
    // Create local directories if they don't exist
    await fsp.mkdir(CONFIG.localAssignmentsDir, { recursive: true });
    await fsp.mkdir(CONFIG.localConvertedDir, { recursive: true });
    console.log('✓ Local directories created/verified');

    console.log(`Using S3 bucket: ${CONFIG.bucketName} (region: ${region})`);
    
    // Note: pdftotext system utility is used for PDF conversion (more reliable than pdf-parse in ES modules)
    // Verify it's available or warn user
    try {
      execSync('which pdftotext', { stdio: 'ignore' });
      console.log('✓ pdftotext utility available for PDF conversion');
    } catch (e) {
      console.warn('⚠ pdftotext not found. Install with: sudo apt-get install poppler-utils (Ubuntu/Debian) or brew install poppler (macOS)');
    }
    
    // Verify S3 access using AWS SDK v3
    const headBucketCommand = new HeadBucketCommand({ Bucket: CONFIG.bucketName });
    // allow trying a different client if we detect the bucket region
    let clientToUse = s3Client;
    try {
      await clientToUse.send(headBucketCommand);
      console.log('✓ S3 bucket access verified');
    } catch (err) {
      // Handle common error cases
      const status = err && err.$metadata && err.$metadata.httpStatusCode;
      if (status === 403) {
        console.error(`✗ Access denied when accessing bucket "${CONFIG.bucketName}". HTTP 403.`);
        console.error(`  RequestId: ${err.$metadata.requestId || 'N/A'}  ExtendedId: ${err.$metadata.extendedRequestId || 'N/A'}`);
        console.error('  Possible causes:');
        console.error('   - The EC2 instance IAM role or provided credentials lack s3:ListBucket / s3:HeadBucket permissions.');
        console.error('   - The bucket has a restrictive bucket policy or ACL that denies access.');
        console.error('   - The bucket name is incorrect or the region is mismatched.');
        console.error('  Suggested checks:');
        console.error('   - Confirm the IAM role attached to this instance and its policies.');
        console.error('   - Inspect the bucket policy for explicit Deny rules.');
        console.error('   - Try the AWS CLI: `aws s3api head-bucket --bucket <bucket>` from a machine with the same creds.');
      } else if (status === 301) {
        // 301 usually means the request was sent to the wrong region for this bucket
        console.error(`✗ Received HTTP 301 for bucket "${CONFIG.bucketName}". This usually means the bucket is in a different region than the client.`);
        console.error(`  RequestId: ${err.$metadata.requestId || 'N/A'}  ExtendedId: ${err.$metadata.extendedRequestId || 'N/A'}`);
        console.error('  Suggested action: determine the bucket region and set AWS_REGION (or AWS_DEFAULT_REGION) to that region, e.g. `export AWS_REGION=eu-west-1`');

        // Try to auto-detect bucket region if possible (requires s3:GetBucketLocation permission)
        try {
          console.log('  Attempting to detect bucket region via GetBucketLocation...');
          const locCmd = new GetBucketLocationCommand({ Bucket: CONFIG.bucketName });
          const locResp = await clientToUse.send(locCmd);
          // AWS returns LocationConstraint which can be null/empty for us-east-1
          let detected = locResp && (locResp.LocationConstraint || locResp.LocationConstraint === '' ? locResp.LocationConstraint : null);
          if (detected === '' || detected === null) detected = 'us-east-1';
          console.log(`  Detected bucket region: ${detected}`);
          if (detected && detected !== region) {
            console.log(`  Reconfiguring client for region ${detected} and retrying...`);
            const newClient = new S3Client({ region: detected });
            clientToUse = newClient;
            await clientToUse.send(headBucketCommand);
            console.log('✓ S3 bucket access verified with detected region');
          }
        } catch (innerErr) {
          // As a last resort, if the AWS CLI is available and user opted into diagnostics, call it
          if (process.env.S3_DIAGNOSE === 'true') {
            try {
              console.log('  Running AWS CLI get-bucket-location as S3_DIAGNOSE=true');
              const out = execSync(`aws s3api get-bucket-location --bucket ${CONFIG.bucketName} --output json`, { encoding: 'utf8' });
              console.log('  AWS CLI output:', out.trim());
            } catch (cliErr) {
              console.error('  AWS CLI get-bucket-location failed or is not available:', cliErr && cliErr.message ? cliErr.message : cliErr);
            }
          } else {
            console.error('  Could not auto-detect bucket region programmatically. Set `S3_DIAGNOSE=true` and ensure the AWS CLI is installed to run an additional diagnostic.');
          }
        }
      } else {
        console.error('Environment setup failed:', err && err.message ? err.message : err);
      }
      // Re-throw so calling code knows setup failed if verification didn't succeed
      throw err;
    }
    
  } catch (error) {
    console.error('Environment setup failed:', error.message);
    throw error;
  }
}

/**
 * Part 3-4: Fetch all PDF assignments from S3 /assignments folder
 */
async function fetchAssignmentsFromS3() {
  console.log('\n--- Fetching Assignments from S3 ---');
  
  try {
    // List all objects in the assignments folder
    const listCommand = new ListObjectsV2Command({
      Bucket: CONFIG.bucketName,
      Prefix: CONFIG.assignmentsFolder
    });
    
    let listedObjects = await s3Client.send(listCommand);

    // If no objects are found under the configured prefix, provide guidance
    // and attempt a fallback listing of the entire bucket (useful when files are at the bucket root)
    if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
      console.warn('No files found under the configured prefix:', CONFIG.assignmentsFolder);
      console.warn('If your files are stored at the bucket root or a different prefix, set ASSIGNMENTS_PREFIX accordingly (empty string for root).');

      // Attempt a fallback to list the entire bucket if a non-empty prefix was configured
      if (CONFIG.assignmentsFolder && CONFIG.assignmentsFolder !== '') {
        console.warn('Attempting fallback: listing entire bucket (no prefix). This may list many objects if the bucket is large).');
        try {
          const fallbackCmd = new ListObjectsV2Command({ Bucket: CONFIG.bucketName });
          listedObjects = await s3Client.send(fallbackCmd);
          if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
            console.log('No objects found in bucket (even without prefix)');
            return [];
          }
        } catch (fallbackErr) {
          console.error('Fallback listing failed:', fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr);
          throw fallbackErr;
        }
      } else {
        return [];
      }
    }
    
    // Filter only PDF files
    const pdfFiles = listedObjects.Contents
      .filter(obj => obj.Key.toLowerCase().endsWith('.pdf'))
      .filter(obj => obj.Key !== CONFIG.assignmentsFolder); // Exclude folder itself
    
    console.log(`Found ${pdfFiles.length} PDF files in S3`);

    // Helpful diagnostic: if the bucket returned objects but none matched PDFs,
    // print a short list of keys so user can verify the prefix and file names.
    if (listedObjects.Contents && listedObjects.Contents.length > 0 && pdfFiles.length === 0) {
      console.warn('Warning: objects were found under the configured prefix but no PDF files matched the filter.');
      console.warn('First few object keys (key : size):');
      listedObjects.Contents.slice(0, 50).forEach(obj => {
        console.warn(` - ${obj.Key} : ${obj.Size} bytes`);
      });
      console.warn('Suggestions:');
      console.warn(' - Check that `CONFIG.assignmentsFolder` / env var ASSIGNMENTS_PREFIX matches the prefix used in S3 (trailing slash matters).');
      console.warn(' - Ensure files actually end with .pdf (case-insensitive).');
      console.warn(' - If files are in a different prefix, set ASSIGNMENTS_PREFIX to that value or leave it empty to list the whole bucket (careful with large buckets).');
    }
    
    // Download each PDF file
    const downloadedFiles = [];
    
    for (const file of pdfFiles) {
      const fileName = path.basename(file.Key);
      const localPath = path.join(CONFIG.localAssignmentsDir, fileName);
      
      console.log(`Downloading: ${fileName}...`);
      
      const getObjectCommand = new GetObjectCommand({
        Bucket: CONFIG.bucketName,
        Key: file.Key
      });
      
      const response = await s3Client.send(getObjectCommand);
      
      // Convert stream to buffer
      const buffer = await streamToBuffer(response.Body);
      await fsp.writeFile(localPath, buffer);
      
      downloadedFiles.push({
        fileName,
        localPath,
        s3Key: file.Key
      });
      
      console.log(`✓ Downloaded: ${fileName}`);
    }
    
    return downloadedFiles;
    
  } catch (error) {
    console.error('Error fetching assignments from S3:', error.message);
    throw error;
  }
}

/**
 * Part 5: Convert all PDFs to text files
 */
async function convertPDFsToText(pdfFiles) {
  console.log('\n--- Converting PDFs to Text ---');
  
  // Use system pdftotext utility for PDF conversion
  // This is more reliable than pdf-parse module in ES module environments
  
  const convertedFiles = [];
  
  for (const pdfFile of pdfFiles) {
    try {
      console.log(`Converting: ${pdfFile.fileName}...`);
      
      // Read PDF file
      const dataBuffer = await fsp.readFile(pdfFile.localPath);
      
      // Create text file name (replace .pdf with .txt)
      const txtFileName = pdfFile.fileName.replace('.pdf', '.txt');
      const txtFilePath = path.join(CONFIG.localConvertedDir, txtFileName);
      
      // Use system pdftotext for conversion
      try {
        execSync(`pdftotext ${JSON.stringify(pdfFile.localPath)} ${JSON.stringify(txtFilePath)}`);
        const txtContent = await fsp.readFile(txtFilePath, 'utf8');
        
        convertedFiles.push({
          originalFile: pdfFile.fileName,
          textFile: txtFileName,
          textPath: txtFilePath,
          characterCount: txtContent.length
        });
        
        console.log(`✓ Converted: ${pdfFile.fileName} -> ${txtFileName} (${txtContent.length} chars)`);
      } catch (pdftErr) {
        throw pdftErr;
      }
      
    } catch (error) {
      // Log detailed error and write a small placeholder text file so user can see conversion failed for this file
      console.error(`Error converting ${pdfFile.fileName}:`, error && error.message ? error.message : error);
      console.error(error && error.stack ? error.stack : 'No stack available');

      // Write a placeholder text file indicating failure
      try {
        const txtFileName = pdfFile.fileName.replace(/\.pdf$/i, '.txt');
        const txtFilePath = path.join(CONFIG.localConvertedDir, txtFileName);
        const failureNotice = `Conversion failed for ${pdfFile.fileName}\nError: ${error && error.message ? error.message : error}\n`;
        await fsp.writeFile(txtFilePath, failureNotice, 'utf-8');
        console.log(`✗ Wrote failure notice to ${txtFileName}`);
      } catch (writeErr) {
        console.error('Failed to write failure notice file:', writeErr && writeErr.message ? writeErr.message : writeErr);
      }

      // Continue with other files even if one fails
      continue;
    }
  }
  
  console.log(`\n✓ Conversion complete: ${convertedFiles.length}/${pdfFiles.length} files processed`);
  
  // Create a summary file
  const summary = {
    timestamp: new Date().toISOString(),
    totalFiles: pdfFiles.length,
    successfulConversions: convertedFiles.length,
    files: convertedFiles
  };
  
  await fsp.writeFile(
    path.join(CONFIG.localConvertedDir, '_conversion_summary.json'),
    JSON.stringify(summary, null, 2)
  );
  
  return convertedFiles;
}

/**
 * Error handling wrapper
 */
async function run() {
  try {
    await main();
    console.log('\n✓ Script execution completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Script execution failed:', error);
    process.exit(1);
  }
}

// Execute the script
run();

// Export functions for testing or modular use
export {
  setupEnvironment,
  fetchAssignmentsFromS3,
  convertPDFsToText,
  CONFIG
};