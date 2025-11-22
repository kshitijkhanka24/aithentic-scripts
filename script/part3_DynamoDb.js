import {DynamoDBClient, PutItemCommand, ScanCommand} from "@aws-sdk/client-dynamodb";

// Initialize AWS clients
const dynamodb = new DynamoDBClient({ region: 'us-east-1' });

function convert(item) {
    // Handle DynamoDB typed value wrappers (S, N, BOOL, M, L)
    if (!item) return null;

    // If the item itself is a typed wrapper, convert accordingly
    if (typeof item === 'object' && ('S' in item || 'N' in item || 'BOOL' in item || 'M' in item || 'L' in item)) {
        if (item.S !== undefined) return item.S;
        if (item.N !== undefined) return Number(item.N);
        if (item.BOOL !== undefined) return item.BOOL;
        if (item.M !== undefined) return convert(item.M);
        if (item.L !== undefined) return item.L.map(convert);
    }

    // Otherwise assume it's a map of attributeName -> typedValue
    const out = {};
    for (const key in item) {
        out[key] = convert(item[key]);
    }
    return out;
}

/**
 * Convert plain JS object to DynamoDB format
 * Recursively wraps values with their type markers (S, N, M, L, BOOL)
 */
let toDynamoDBFormat =  (obj) => {
    if (obj === null || obj === undefined) {
        return null;
    }

    const dynamoObj = {};

    for (const key in obj) {
        const val = obj[key];

        if (typeof val === 'string') {
            dynamoObj[key] = { S: val };
        } else if (typeof val === 'number') {
            dynamoObj[key] = { N: String(val) };
        } else if (typeof val === 'boolean') {
            dynamoObj[key] = { BOOL: val };
        } else if (Array.isArray(val)) {
            dynamoObj[key] = { L: val.map(item => {
                if (typeof item === 'string') return { S: item };
                if (typeof item === 'number') return { N: String(item) };
                if (typeof item === 'boolean') return { BOOL: item };
                if (typeof item === 'object') return { M: toDynamoDBFormat(item) };
                return { S: String(item) };
            })};
        } else if (typeof val === 'object') {
            dynamoObj[key] = { M: toDynamoDBFormat(val) };
        } else {
            dynamoObj[key] = { S: String(val) };
        }
    }

    return dynamoObj;
}

async function generateAnalyticsSummary(analyticsId) {

    try {
          const command = new ScanCommand({
              TableName: "assignment_analysis_data"
          });
        
          const raw = await dynamodb.send(command);
        
          // Convert all rows to normal JS
          const allAssignments = raw.Items.map(item => convert(item));
          const filtered = allAssignments.filter(e => e.analyticsId === analyticsId);

          console.log(filtered);

        // Initialize counters and collectors
        let submissionCount = 0;
        let totalGrade = 0;
        let topGrade = -Infinity;
        let bottomGrade = Infinity;
        let totalAIPercentage = 0;
        let countAIUsed = 0;
        let countAIOver70 = 0;
        let totalPlagiarism = 0;
        let countPlagiarized = 0;
        let listAIAbove70 = [];
        let listPlagiarismAbove50 = [];

        // Process each assignment
        filtered.forEach(item => {
            submissionCount++;
            
            // Grade analytics - extract from gradeReceived
            const grade = item.gradeReceived || 0;
            totalGrade += grade;
            topGrade = Math.max(topGrade, grade);
            bottomGrade = Math.min(bottomGrade, grade);

            // AI analytics - extract from aiGeneratedAnalytics
            const aiPercentage = (item.aiGeneratedAnalytics && item.aiGeneratedAnalytics.percentageOfAIUsed) || 0;
            totalAIPercentage += aiPercentage;
            if (aiPercentage > 0) countAIUsed++;
            if (aiPercentage > 70) {
                countAIOver70++;
                listAIAbove70.push({
                    assignmentId: item.assignmentId,
                    aiPercentage: aiPercentage,
                    grade: grade
                });
            }

            // Plagiarism analytics - extract from plagarismAnalytics
            const plagiarismPercentage = (item.plagarismAnalytics && item.plagarismAnalytics.plagarisedPercentage) || 0;
            totalPlagiarism += plagiarismPercentage;
            if (plagiarismPercentage > 0) countPlagiarized++;
            if (plagiarismPercentage > 50) {
                listPlagiarismAbove50.push({
                    assignmentId: item.assignmentId,
                    plagiarismPercentage: plagiarismPercentage,
                    grade: grade
                });
            }
        });

        // Calculate averages
        const summary = {
            analyticsId: analyticsId,
            timestamp: new Date().toISOString(),
            submissionCount: submissionCount,
            gradeDistribution: {
                topGrade: topGrade === -Infinity ? 0 : topGrade,
                bottomGrade: bottomGrade === Infinity ? 0 : bottomGrade,
                averageGrade: submissionCount > 0 ? Math.round((totalGrade / submissionCount) * 100) / 100 : 0
            },
            aiGeneratedAnalytics: {
                averagePercentageOfAIUsed: countAIUsed > 0 ? Math.round((totalAIPercentage / submissionCount) * 100) / 100 : 0,
                countOfAssignmentsUsedAI: countAIUsed,
                countOfAssignmentsUsedAIOver70: countAIOver70
            },
            plagarismAnalytics: {
                noOfPlagarisedAssignments: countPlagiarized,
                averagePercentageOfPlagarism: countPlagiarized > 0 ? Math.round((totalPlagiarism / countPlagiarized) * 100) / 100 : 0
            },
            listOfAIGeneratedAssignementsAbove70: listAIAbove70,
            listOfPlagarisedAssignmentsAbove50: listPlagiarismAbove50
        };
        console.log("Generated Analytics Summary:", summary);
        return summary;
    } catch (error) {
        console.error("Error generating analytics summary:", error);
        throw error;
    }
}

// Upload summary to DynamoDB
async function uploadAnalyticsSummary(summary, dynamodb, summaryTableName) {
    try {
        // Convert plain JS object to DynamoDB format
        const dynamoDBItem = toDynamoDBFormat(summary);
        
        const command = new PutItemCommand({
            TableName: summaryTableName,
            Item: dynamoDBItem
        });
        
        await dynamodb.send(command);
        console.log(`Analytics summary uploaded successfully with ID: ${summary.analyticsId}`);
        return summary;
    } catch (error) {
        console.error("Error uploading analytics summary:", error);
        throw error;
    }
}

generateAnalyticsSummary(1)

async function main(){
    let analyticsId = 1;
    const summary = await generateAnalyticsSummary(analyticsId);
    await uploadAnalyticsSummary(summary, dynamodb, "analysis_data");
}

main();

toDynamoDBFormat =  (obj) => {
    if (obj === null || obj === undefined) {
        return null;
    }

    const dynamoObj = {};

    for (const key in obj) {
        const val = obj[key];

        if (typeof val === 'string') {
            dynamoObj[key] = { S: val };
        } else if (typeof val === 'number') {
            dynamoObj[key] = { N: String(val) };
        } else if (typeof val === 'boolean') {
            dynamoObj[key] = { BOOL: val };
        } else if (Array.isArray(val)) {
            dynamoObj[key] = { L: val.map(item => {
                if (typeof item === 'string') return { S: item };
                if (typeof item === 'number') return { N: String(item) };
                if (typeof item === 'boolean') return { BOOL: item };
                if (typeof item === 'object') return { M: toDynamoDBFormat(item) };
                return { S: String(item) };
            })};
        } else if (typeof val === 'object') {
            dynamoObj[key] = { M: toDynamoDBFormat(val) };
        } else {
            dynamoObj[key] = { S: String(val) };
        }
    }

    return dynamoObj;
}
async function generateHomeDataSummary() {
    try {
        // Fetch all analytics summaries from the analysis_data table
        const command = new ScanCommand({
            TableName: "analysis_data"
        });

        const raw = await dynamodb.send(command);

        // Convert all rows to normal JS
        const allSummaries = raw.Items.map(item => convert(item));

        // Initialize aggregators
        let totalNoAssignments = 0;
        let analyzedAssignments = 0;
        let totalSubmissionCount = 0;
        let totalTopGrades = 0;
        let totalBottomGrades = 0;
        let totalAverageGrades = 0;
        let totalAIPercentage = 0;
        let totalCountAIUsed = 0;
        let totalCountAIOver70 = 0;
        let totalPlagiarizedAssignments = 0;
        let totalPlagiarismPercentage = 0;
        let aggregatedAIAbove70 = [];
        let aggregatedPlagiarismAbove50 = [];

        // Process each analytics summary
        allSummaries.forEach(summary => {
            totalNoAssignments++;
            analyzedAssignments++;
            totalSubmissionCount += summary.submissionCount || 0;

            // Grade distribution
            if (summary.gradeDistribution) {
                totalTopGrades += summary.gradeDistribution.topGrade || 0;
                totalBottomGrades += summary.gradeDistribution.bottomGrade || 0;
                totalAverageGrades += summary.gradeDistribution.averageGrade || 0;
            }

            // AI analytics
            if (summary.aiGeneratedAnalytics) {
                totalAIPercentage += summary.aiGeneratedAnalytics.averagePercentageOfAIUsed || 0;
                totalCountAIUsed += summary.aiGeneratedAnalytics.countOfAssignmentsUsedAI || 0;
                totalCountAIOver70 += summary.aiGeneratedAnalytics.countOfAssignmentsUsedAIOver70 || 0;
            }

            // Plagiarism analytics
            if (summary.plagarismAnalytics) {
                totalPlagiarizedAssignments += summary.plagarismAnalytics.noOfPlagarisedAssignments || 0;
                totalPlagiarismPercentage += summary.plagarismAnalytics.averagePercentageOfPlagarism || 0;
            }

            // Aggregate lists
            if (summary.listOfAIGeneratedAssignementsAbove70) {
                aggregatedAIAbove70.push(...summary.listOfAIGeneratedAssignementsAbove70);
            }
            if (summary.listOfPlagarisedAssignmentsAbove50) {
                aggregatedPlagiarismAbove50.push(...summary.listOfPlagarisedAssignmentsAbove50);
            }
        });

        // Calculate averages
        const homeData = {
            id: 1,
            isAssignmentToBeAnalyzed: totalNoAssignments > analyzedAssignments,
            totalNoAssignments: totalNoAssignments,
            analyzedAssignments: analyzedAssignments,
            averageSubmissionCount: analyzedAssignments > 0 ? Math.round((totalSubmissionCount / analyzedAssignments) * 100) / 100 : 0,
            gradeDistribution: {
                topGrade: totalTopGrades > 0 ? Math.max(...allSummaries.map(s => s.gradeDistribution?.topGrade || 0)) : 0,
                bottomGrade: totalBottomGrades > 0 ? Math.min(...allSummaries.map(s => s.gradeDistribution?.bottomGrade || 0)) : 0,
                averageGrade: analyzedAssignments > 0 ? Math.round((totalAverageGrades / analyzedAssignments) * 100) / 100 : 0
            },
            aiGeneratedAnalytics: {
                averagePercentageOfAIUsed: analyzedAssignments > 0 ? Math.round((totalAIPercentage / analyzedAssignments) * 100) / 100 : 0,
                countOfAssignmentsUsedAI: totalCountAIUsed,
                countOfAssignmentsUsedAIOver70: totalCountAIOver70
            },
            plagarismAnalytics: {
                noOfPlagarisedAssignments: totalPlagiarizedAssignments,
                averagePercentageOfPlagarism: totalPlagiarizedAssignments > 0 ? Math.round((totalPlagiarismPercentage / analyzedAssignments) * 100) / 100 : 0
            },
            listOfAIGeneratedAssignementsAbove70: aggregatedAIAbove70,
            listOfPlagarisedAssignmentsAbove50: aggregatedPlagiarismAbove50,
            timestamp: new Date().toISOString()
        };

        console.log("Generated Home Data Summary:", homeData);
        return homeData;
    } catch (error) {
        console.error("Error generating home data summary:", error);
        throw error;
    }
}

/**
 * Upload or update home_data with the aggregated summary
 * Always updates the item with id: 1
 */
async function uploadHomeDataSummary(homeData) {
    try {
        // Convert plain JS object to DynamoDB format
        const dynamoDBItem = toDynamoDBFormat(homeData);

        const command = new PutItemCommand({
            TableName: "home_data",
            Item: dynamoDBItem
        });

        await dynamodb.send(command);
        console.log("Home data summary uploaded/updated successfully with ID: 1");
        return homeData;
    } catch (error) {
        console.error("Error uploading home data summary:", error);
        throw error;
    }
}

/**
 * Main execution: Generate and upload home data
 */
async function updateHomeData() {
    const homeData = await generateHomeDataSummary();
    await uploadHomeDataSummary(homeData);
}

updateHomeData();