var AWS = require('aws-sdk');
var logger = require('./logger');
const _ = require('lodash');
const region = process.env.AWS_REGION || "cn-northwest-1";
const ECS = new AWS.ECS({
    region: region
});
const dynamo = new AWS.DynamoDB.DocumentClient({
    region: region
});
const TABLE_NAME = process.env.TABLE_NAME || "video-streaming";
var segmentTime = process.env.SEGMENT_TIME || "30";
var segmentFormat = process.env.SEMMENT_FORMAT || "video";
const bucketName = process.env.ASSETS_BUCKET || "video-streaming-assets-assetsbucket-1kf2tlxbhy4qz";
var logLevel = process.env.LOG_LEVEL || "warning";

var transCoding = process.env.TRANSCODING || "copy";
var sizing = process.env.SIZING || "default";
//
var ecs_Type = process.env.ECS_TYPE || "fargate";
const clusterName = process.env.ECS_CLUSTER_NAME || 'video-streaming';
const taskName = process.env.ECS_TASK_NAME || 'video-streaming-processor:4'
const containerName = process.env.ECS_CONTAINER_NAME || 'video-streaming-processor';
const taskNumber=1;

const invokeTask = async (event, callback) => {
    // return new Promise(async (resolve, reject) => {
            // logger.log("-----event----" + JSON.stringify(event));
            if (event.eventName == "start") {
               await startTasks(event)
            }
            if (event.eventName == "stop") {
               await stopTasks(event);
            }
    // });
}

const startTasks = async (event) => {
    try {
       const inputUrl = event.url; //get media url
       const streamChannel = event.id;
        logger.log('Run task with deviceURL:' + inputUrl + "  UUID:" + streamChannel);
        //run ecs task
        const data = await ECS.runTask(getECSParam(event)).promise();
        const arns = _.map(data.tasks, (task) => {
            return task.taskArn;
          });
        // data.tasks.forEach(task => {
        //     arns.push(task.taskArn);
        // });
        var item = new Object();
        item.UUID = streamChannel;
        item.URL = inputUrl;
        item.ServerAddress=event.address;
        item.taskARN = arns;
        await saveItem(item).then(response => {
            logger.log("saveItem into dynamodb success" + JSON.stringify(response));
        }, (reject) => {
            logger.log("saveItem into dynamodb error" + reject);
        });
    } catch (error) {
        logger.log("start task error:" + error);
    }
}

const stopTasks = async (event) => {
    try {
        const streamChannel = event.id;
        const item = await getItem(streamChannel);
        if (typeof (item) != 'undefined') {
            logger.log("stop task with:" + JSON.stringify(item));
            await  item.taskARN.forEach(taskarn => {
                const params = {
                    task: taskarn,
                    cluster: clusterName,
                    reason: 'stop recording'
                };
               ECS.stopTask(params).promise();
            });
            await deleteItem(streamChannel);
            logger.log("delete db record success:" + streamChannel);
        }
    } catch (error) {
        logger.log("execute stop task error:" + error);
    }
}

function getECSParam(event) {

    if (ecs_Type == "fargate")
        return getFargateParams(event);
    else
        return getEC2Params(event);
}

function getEC2Params(event) {
    const metaData = event.metaData;
    const task_num=metaData.task_num|| taskNumber;
    return {
        cluster: clusterName,
        taskDefinition: taskName,
        // placementConstraints: [
        //     {
        //       expression: 'STRING_VALUE',
        //       type: distinctInstance | memberOf
        //     },
        //     /* more items */
        //   ],
          placementStrategy: [
            {
                "type": "random"
            },
          ],
        overrides: {
            containerOverrides: [{
                name: containerName,
                environment:getEnv(event)
            }]
        },
        count: task_num,
        launchType: "EC2",
        networkConfiguration: {
            awsvpcConfiguration: {
                subnets: [process.env.SUBNET_ID1 || 'subnet-0c501e7112e0d94f9',
                    process.env.SUBNET_ID2 || 'subnet-03799a358aa837963'
                ],
                assignPublicIp: "DISABLED",
                securityGroups: [
                    process.env.SECURITY_GROUP || 'sg-0012e02d07ded4562', //security group
                ]
            }
        },
    };
}


function getFargateParams(event) {
    const metaData = event.metaData;
    const task_num=metaData.task_num|| taskNumber;
    return {
        cluster: clusterName,
        taskDefinition: taskName,
        networkConfiguration: {
            awsvpcConfiguration: {
                subnets: [process.env.SUBNET_ID1 || 'subnet-0c501e7112e0d94f9',
                    process.env.SUBNET_ID2 || 'subnet-03799a358aa837963'
                ],
                assignPublicIp: "ENABLED",
                securityGroups: [
                    process.env.SECURITY_GROUP || 'sg-0012e02d07ded4562', //security group
                ]
            }
        },
        overrides: {
            containerOverrides: [{
                name: containerName,
                environment:getEnv(event)
            }]
        },
        count: task_num,
        launchType: "FARGATE",
        platformVersion: '1.4.0'
    };
}

function getEnv(event)
{
    const metaData = event.metaData;
  return  [
    { name: "INPUT_URL", "value": event.url },
    { name: "ADDRESS", "value": event.address },
    { name: "SEGMENT_FORMAT", "value": segmentFormat },
    { name: "LOG_LEVEL", "value": logLevel },
    { name: "REGION", "value": region },
    { name: "TRANSCODING", "value": transCoding },
    { name: "SIZING", "value": sizing },
    { name: "SEGMENT_TIME", "value": segmentTime },
    { name: "CHANNEL_NAME", "value": event.id },
    { name: "IS_MASTER", "value": event.isMaster },
    { name: "IS_FLV", "value": metaData.isFlv || 'true'},
    { name: "IS_HLS", "value": metaData.isHls || 'false'},
    { name: "IS_VIDEO", "value": metaData.isVideo || 'false'},
    { name: "IS_IMAGE", "value": metaData.isImage || 'false'},
    { name: "IS_MOTION", "value": metaData.isMotion || 'false'},
    { name: "IS_ONDEMAND", "value": metaData.isOnDemand || 'false'},
    { name: "IS_CMAF", "value": metaData.isCMAF || 'false'},
    { name: "VIDEO_TIME", "value": metaData.video_time|| "30" },
    { name: "IMAGE_TIME", "value": metaData.image_time|| "10" },
    { name: "HLS_TIME", "value": metaData.hls_time || "2"},
    { name: "HLS_LIST_SIZE", "value": metaData.hls_list_size|| "6" }, 
//motion detect
    { name: "MOTION_DURATION", "value": metaData.motion_duration|| "5000" },
    { name: "MOTION_PERCENT", "value": metaData.motion_percent || "30"},
    { name: "MOTION_TIMEOUT", "value": metaData.motion_timeout || "60"},
    { name: "MOTION_DIFF", "value": metaData.motion_diff|| "10" },
//ondemand video
    { name: "ONDEMAND_LIST_SIZE", "value": metaData.ondemand_list_size || "3"},
    { name: "ONDEMAND_TIME", "value": metaData.ondemand_time || "60"},
]
}


function saveItem(item) {
    const params = {
        TableName: TABLE_NAME,
        Item: item
    };

    return dynamo
        .put(params)
        .promise()
        .then((result) => {
            return item;
        }, (error) => {
            return error;
        });
}

function getItem(itemId) {
    const params = {
        Key: {
            UUID: itemId
        },
        TableName: TABLE_NAME
    };

    return dynamo
        .get(params)
        .promise()
        .then((result) => {
            return result.Item;
        }, (error) => {
            return error;
        });
}

function deleteItem(itemId) {
    const params = {
        Key: {
            UUID: itemId
        },
        TableName: TABLE_NAME
    };
    return dynamo.delete(params).promise();
}

module.exports = {
    invokeTask
};