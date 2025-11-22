// Aithentic Assignment Grading System - Parts 9 & 10
// DynamoDB storage and EC2 instance termination
// Using AWS SDK v3

import { EC2Client, TerminateInstancesCommand, DescribeInstancesCommand} from '@aws-sdk/client-ec2';

// Configure AWS SDK v3
// 🔴 IMPORTANT: Change 'us-east-1' to your AWS region if different
const ec2Client = new EC2Client({ region: 'us-east-1' });

// ===== 🔴 CONFIGURATION: MODIFY THESE WITH YOUR AWS RESOURCES 🔴 =====
const CONFIG = {

  // 🔴 OPTIONAL: Set to true if you want to auto-terminate EC2 after completion
  autoTerminateEC2: true,

  // 🔴 OPTIONAL: EC2 instance ID (can be obtained from metadata or environment)
  // If not set, script will attempt to read from EC2 metadata
  ec2InstanceId: process.env.INSTANCE_ID || null,

  // AWS region
  awsRegion: 'us-east-1',

};
// ===== 🔴 END OF REQUIRED CONFIGURATION 🔴 =====

/**
 * Get EC2 Instance ID from metadata service
 */
async function getInstanceId() {
  try {
    // Get token for IMDSv2
    const tokenResponse = await fetch('http://169.254.169.254/latest/api/token', {
      method: 'PUT',
      headers: {
        'X-aws-ec2-metadata-token-ttl-seconds': '21600'
      }
    });
    const token = await tokenResponse.text();
    
    // Use token to get instance ID
    const response = await fetch('http://169.254.169.254/latest/meta-data/instance-id', {
      headers: {
        'X-aws-ec2-metadata-token': token
      }
    });
    const instanceId = await response.text();
    console.log('Instance ID is:', instanceId);
    return instanceId;
  } catch (err) {
    console.error('Error:', err.message);
  }
}

/**
 * Part 10: Terminate EC2 instance
 */
async function terminateEC2Instance() {
  console.log('\n--- Part 10: Terminating EC2 Instance ---');

  try {
    let instanceId = CONFIG.ec2InstanceId;

    // If no instance ID provided, try to get from metadata service
    if (!instanceId) {
      instanceId = await getInstanceId();
    }

    if (!instanceId) {
      console.warn('⚠️  Cannot determine EC2 instance ID. Skipping termination.');
      console.warn('Set EC2_INSTANCE_ID environment variable or configure in CONFIG');
      return false;
    }

    console.log(`Terminating EC2 instance: ${instanceId}`);

    // Verify instance exists and get its status
    console.log('Verifying instance status...');
    const describeCommand = new DescribeInstancesCommand({
      InstanceIds: [instanceId]
    });

    const describeResponse = await ec2Client.send(describeCommand);
    const instance = describeResponse.Reservations[0]?.Instances[0];

    if (!instance) {
      console.error(`Instance ${instanceId} not found`);
      return false;
    }

    const currentState = instance.State.Name;
    console.log(`Current instance state: ${currentState}`);

    if (currentState === 'terminated' || currentState === 'terminating') {
      console.log('Instance is already terminated or terminating');
      return true;
    }

    // Terminate the instance
    console.log(`Sending termination command to ${instanceId}...`);

    const terminateCommand = new TerminateInstancesCommand({
      InstanceIds: [instanceId]
    });

    const terminateResponse = await ec2Client.send(terminateCommand);

    console.log('✓ Termination initiated');
    console.log(`  Instance ID: ${terminateResponse.TerminatingInstances[0].InstanceId}`);
    console.log(`  Current state: ${terminateResponse.TerminatingInstances[0].CurrentState.Name}`);
    console.log(`  Previous state: ${terminateResponse.TerminatingInstances[0].PreviousState.Name}`);

    return true;

  } catch (error) {
    console.error('Error terminating EC2 instance:', error.message);
    throw error;
  }
}


async function main(inferenceResults) {
  try {
    console.log('=== Aithentic 10 Processing Started ===');
    console.log(`Timestamp: ${new Date().toISOString()}`);

    // Part 10: Terminate EC2 (if enabled)
    if (CONFIG.autoTerminateEC2) {
      console.log('\n🔔 EC2 Auto-termination is enabled');
      await terminateEC2Instance();
    } else {
      console.log('\n🔔 EC2 Auto-termination is disabled');
      console.log('To terminate manually, run:');
      console.log(`   aws ec2 terminate-instances --instance-ids <instance-id>`);
    }

    console.log('\n=== Parts 9-10 Completed Successfully ===');
  } catch (error) {
    console.error('Error in main execution:', error);
    throw error;
  }
}

/**
 * Error handling wrapper
 */
main()
