'use strict'

const fs = require('fs');
const path = require('path');
const proc = require('child_process');
const s3lib = require('s3');
const AWS = require('aws-sdk');
const zip = require('zipfolder');
const async = require('async');
const prettyBytes = require('pretty-bytes');
const _ = require('underscore');
const moment = require('moment');
const transmission = require('./transmission.js');
const utils = require('./utils.js');

// Create S3 lib client
const s3client = s3lib.createClient({
	maxAsyncS3: 20,			// this is the default
	s3RetryCount: 3,		// this is the default
	s3RetryDelay: 1000,	// this is the default
	multipartUploadThreshold: 20971520,	// this is the default (20 MB)
	multipartUploadSize: 15728640,			// this is the default (15 MB)
	s3Options: {
		accessKeyId: process.env.AWS_ACCESS_KEY_ID,
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
		region: process.env.AWS_REGION,
		// endpoint: 's3.yourdomain.com',
		// sslEnabled: false
		// any other options are passed to new AWS.S3()
		// See: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Config.html#constructor-property
	}
});

exports.s3client = s3client;


/*----------------------------------------------------*/
// Auxiliary functions
/*----------------------------------------------------*/

function createZip(source, dest, callback){
	console.log('Create zip', source, dest);
	try {

		var zipName = dest + path.basename(source) + '.zip';
		var zipExists = fs.existsSync(zipName);
		if (!zipExists) {
			if (fs.lstatSync(source).isDirectory()){
				var zipName = dest + path.basename(source) + '.zip';
				zip.zipFolder({folderPath: source}, function (err, zipPath) {
					if (err) {
						callback(err);
					} else {
						callback(null, path.basename(zipName));
					}
				});
			} else {
				console.log('Don\'t create zip for file', path.basename(source))
				callback(null, path.basename(source))
			}
		} else {
			console.log('Zip already created:', zipName);
			callback(null, path.basename(zipName));
		}
	} catch(err) {
		callback(err);
	}
}

function getContentTypeByFile(fileName) {
	var rc = 'application/octet-stream',
			ext = path.extname(fileName.toLowerCase());

	switch (ext) {
		case '.html':
		case '.txt':
		case '.css': {
			rc = 'text/'+ext.split('.')[1]; break;
		}
		case '.png':
		case '.jpg': {
			rc = 'image/'+ext.split('.')[1]; break;
		}
		case '.json': rc = 'application/json'; break;
		case '.js': rc = 'application/x-javascript'; break;
	}

	return rc;
}

function uploadMultipart(client, username, absoluteFilePath, fileName, uploadCb) {
	try {
		//Create params object for the upload
		var params = {
			localFile: absoluteFilePath,
			s3Params: {
				Bucket: process.env.S3_BUCKET,
				Key: username + '/' + fileName,
				ACL: 'public-read',
				ContentType: getContentTypeByFile(fileName)
					// other options supported by putObject, except Body and ContentLength.
					// See: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property
			}
		};

		//Create uploader
		var uploader = s3client.uploadFile(params);

		uploader.on('error', function(err) {
			uploader.abort();
			uploadCb(err);
		});
		uploader.on('progress', function() {
			var progress = parseFloat((uploader.progressAmount/uploader.progressTotal)*100).toFixed(2)
			client.emit('progress', {fileName: fileName, progress: progress});
		});
		uploader.on('end', function(data) {
			console.log('s3client[finish upload]: ', data);
			uploadCb(null,data);
		});
	} catch(err) {
		console.log('Error uploading multipart file to S3', err);
		uploadCb(err);
	}
}

function deleteFiles(client, torrentId, files, deleteCb){
	console.log('Deleting files', files);
	var exec = proc.exec;
	async.forEachSeries(files, function(file, cb){
		exec('rm -Rif "' + file + '"', cb);
	}, function(err){
		transmission.delete(client,torrentId,true);
		deleteCb(err);
	});
}

/*----------------------------------------------------*/
// Module functions
/*----------------------------------------------------*/
exports.createZip = createZip;

exports.upload = function(client, username, torrent, callback){
	console.log('Upload files', username, torrent.name);
	try {
		var user = utils.sanitize(username),
				fileName = '/home/'+user+'/downloads/'+utils.sanitizeURI(torrent.name),
				baseDir = '/home/'+user+'/downloads/';

		// Create zip
		createZip(fileName, baseDir, function(err, zipName) {
			if (err){
				console.log('Error creating zip', err);
				callback(err)
			}
			else {
				console.log('Success creating zip', zipName);
				var url = s3lib.getPublicUrl(process.env.S3_BUCKET, user + '/' + zipName, process.env.AWS_REGION);
				// First, check if file already exists in S3
				var params = { Bucket: process.env.S3_BUCKET, Key: zipName };
				var s3aws = new AWS.S3();
				s3aws.headObject(params, function (err, metadata) {
					console.log('Check if file exists', url, err, metadata);
					if (err && (err.code === 'NotFound' || err.code === 'Forbidden')) {
						// If it doesn't exists --> Upload
						var absoluteFilePath = path.basename(baseDir+zipName);
						uploadMultipart(client, user, baseDir+zipName, absoluteFilePath, function(err, data){
							if (err) {
								console.log('Error uploading zip file', err);
								callback({'error':{'message':err.message,'status': 500}});
							}
							else {
								deleteFiles(client, torrent.id, [baseDir+zipName, fileName], function(err, result){
									if (err) { console.log('Error deleting zip and torrent files', err); }
									callback(null, url);
								});
							}
						});
					} else {
						deleteFiles(client, torrent.id, [baseDir+zipName, fileName], function(err, result){
							if (err) { console.log('Error deleting zip and torrent files', err); }
							callback(null, url);
						});
					}
				});
			}
		});
	} catch(err) {
		console.log('Error uploading files', err);
		callback(err);
	}
}

exports.getLinks = function(username, callback){
	var s3aws = new AWS.S3();
	s3aws.listObjectsV2({
		Bucket: process.env.S3_BUCKET,
		Prefix: utils.sanitize(username)
	}, function(err, data) {
		if (err) {
			callback(err)
		} else {
			var files = [];
			if(data.Contents.length > 0){
				_.each(data.Contents, function(f){
					if (f.Key !== username+'/'){
							var file = {};
							file.LastModified = moment(f.LastModified).format('DD/MM/YYYY - HH:mm:ss')
							file.Size = prettyBytes(f.Size)
							file.Key = f.Key
							files.push(file)
					}
				});
			}
			callback(null, files);
		}
	});
}

exports.getFileURL = function(username, file){
	console.log('getFileURL', process.env.S3_BUCKET, username + '/' + file, process.env.AWS_REGION);
	return s3lib.getPublicUrl(process.env.S3_BUCKET, utils.sanitize(username) + '/' + file, process.env.AWS_REGION);
}

exports.deleteS3Object = function(username, file, callback){
	console.log('deleteS3Object', process.env.S3_BUCKET, username + '/' + file);
	var s3aws = new AWS.S3();
	s3aws.deleteObject({
		Bucket: process.env.S3_BUCKET,
		Key: utils.sanitize(username) + '/' + file
	}, callback);
}
