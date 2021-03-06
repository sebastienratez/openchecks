/**
 * Copyright 2016 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *  https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var openwhisk = require('openwhisk');
var Cloudant = require('cloudant');
var async = require('async');
var fs = require('fs');
var request = require('request');
    
var m_currentCursorPosition = 0;
var m_currentSequenceNumberProcessedInThisBatch = 0;
var m_lastSequenceNumberProcessedInThisBatch = 0;
var m_lastSequenceIdProcessedInThisBatch = 0;
var m_auditedImages = [];
var m_ow;

/**
 * This action is triggered by a new check image added to a CouchDB database.
 * This action is idempotent. If it fails, it can be retried.
 *
 * 1. Fetch the record from the 'audited' database and find its attachment along with
 *    deposit to and account information.
 * 2. Process the image for deposit to account, routing number and move it to
 *    another 'parsed' database with metadata and a confidence score.
 *
 * @param   params.CLOUDANT_USER              Cloudant username
 * @param   params.CLOUDANT_PASS              Cloudant password
 * @param   params.CLOUDANT_HOST              host:port of the http cloudant database
 * @param   params.CLOUDANT_LAST_SEQUENCE_DATABASE  
 * @param   params.CLOUDANT_AUDITED_DATABASE  Cloudant database to store the original copy to
 * @param   params.CLOUDANT_PARSED_DATABASE   Cloudant database to store the parsed check data to
 * @param   params.CLOUDANT_REJECTED_DATABASE Cloudant database to store the rejected check data to
 * @param   params.CURRENT_NAMESPACE          The current namespace so we can call the OCR action by name
 * @return                                    Standard OpenWhisk success/error response
 */
function main(params) {
    console.log(params);

    return new Promise(function(resolve, reject) {
        var url = "http://" + params.CLOUDANT_HOST + "/" + params.CLOUDANT_LAST_SEQUENCE_DATABASE + "/_all_docs?limit=1&descending=true&include_docs=true";
        request.get(url, function(error, response, body) {
            if (error) {
                reject(error);
            } else {
                var result = JSON.parse(body);
                var rowsAmount = result.rows.length;

                var lastSequenceIdentifier;
                if (rowsAmount !== 0) {
                    lastSequenceIdentifier = result.rows[0].doc.lastSequenceIdentifier;
                } else {
                    lastSequenceIdentifier = 0;
                }
                console.log("lastSequenceIdentifier: " + lastSequenceIdentifier);
                resolve( { lastSequenceIdentifier: lastSequenceIdentifier } );
            }
        });
    }).then(function(lastSequenceIdentifierResponse) {
        var lastSequenceIdentifier = lastSequenceIdentifierResponse.lastSequenceIdentifier;
        var url = "http://" + params.CLOUDANT_HOST + "/" + params.CLOUDANT_AUDITED_DATABASE + "/_changes?include_docs=true";
        if (lastSequenceIdentifier !== 0) url += "&since=" + lastSequenceIdentifier;
        
        return new Promise(function(resolve, reject) {
            request.get(url, function(error, response, body) {
                //console.log("Request to get all docs returned: ");
                //console.log(JSON.parse(body));
                if (error) {
                    console.log("Retrieving 'changed' audited documents failed...", error);
                    reject(error);
                } else {
                    //console.log(JSON.parse(body));
                    console.log(url);
                    var body = JSON.parse(body);
                    var results = body.results;
                    
                    console.log("TOTAL Documents Found: " + results.length + " records - last seq = ", lastSequenceIdentifier, ", last seq in this incoming batch:", body.last_seq);
                    m_currentCursorPosition = 0;
                    m_auditedImages = results;
                    continueProcessingImages(params, resolve, reject);
                }
            });
        });
    });
}


function continueProcessingImages(params, resolve, reject) {
    var result = m_auditedImages[m_currentCursorPosition];
    if (m_lastSequenceNumberProcessedInThisBatch !== 0 && 
            ((m_currentSequenceNumberProcessedInThisBatch !== m_lastSequenceNumberProcessedInThisBatch) 
            || m_currentSequenceNumberProcessedInThisBatch === 0)) {
        var p = updateLastRetrievedSequenceId(params, reject);
        if (!result) return p.then(function() { resolve({done: true}); });
    } else {
        if (!result) return resolve({done: true});
    }
    
    //if (m_currentCursorPosition===0) console.log("First result document is ", result);
    m_currentCursorPosition++;
    
    var deleted = result.deleted;
    var sequenceNumber = result.seq[0];
    var sequenceId = result.seq[1];
    if (deleted) {
        if (sequenceNumber > m_lastSequenceNumberProcessedInThisBatch) {
            m_lastSequenceNumberProcessedInThisBatch = sequenceNumber;
            m_lastSequenceIdProcessedInThisBatch = sequenceId;
        }
        return continueProcessingImages(params, resolve, reject);
    } else {
        var id = result.id;
        if (!m_ow) {
            var API_KEY = process.env.OW_API_KEY || process.env.__OW_API_KEY;
            //var API_URL = process.env.OW_API_URL || process.env.__OW_API_URL;
            var API_HOST = "172.17.0.1"; //process.env.OW_API_HOST || process.env.__OW_API_HOST;
            var NAMESPACE = process.env.OW_NAMESPACE || process.env.__OW_NAMESPACE;
            var owparams = {apihost: API_HOST, api_key: API_KEY, namespace: NAMESPACE, ignore_certs: true}
            //console.log(owparams);
            var m_ow = openwhisk(owparams);
        }
        console.log("[" + m_currentCursorPosition + "] Calling OCR docker action for image id:", id);
        return m_ow.actions.invoke({
          actionName: "santander/parse-check-with-ocr",
          params: {
            CLOUDANT_HOST: params.CLOUDANT_HOST,
            CLOUDANT_USER: params.CLOUDANT_USER,
            CLOUDANT_PASS: params.CLOUDANT_PASS,
            CLOUDANT_AUDITED_DATABASE: params.CLOUDANT_AUDITED_DATABASE,
            IMAGE_ID: id,
            ATTACHMENT_NAME: "att-" + id
          },
          blocking: true
        }).then(function(idAudited) { return function(ocrResult) {
            console.log("OCR Call Succeeded.");
            var result = ocrResult.response.result.result;
            var plainMicrCheckText = Buffer.from(result.plaintext, 'base64').toString("ascii");

            var bankingInfo = parseMicrDataToBankingInformation(plainMicrCheckText);
            if (bankingInfo.invalid()) {      
                return insertRejectedCheckInfo(params, idAudited, result.email, result.toAccount, result.amount)
                    .then(
                        function(sequenceNumber, sequenceId) { return function() {
                            if (sequenceNumber > m_lastSequenceNumberProcessedInThisBatch) {
                                m_lastSequenceNumberProcessedInThisBatch = sequenceNumber;
                                m_lastSequenceIdProcessedInThisBatch = sequenceId;
                            }

                            return continueProcessingImages(params, resolve, reject);
                        }}(sequenceNumber, sequenceId)
                    );
            } else {
                return insertProcessedCheckInfo(params, bankingInfo, idAudited, result.email, result.toAccount, result.amount)
                    .then(
                        function(sequenceNumber, sequenceId) { return function() {
                            if (sequenceNumber > m_lastSequenceNumberProcessedInThisBatch) {
                                m_lastSequenceNumberProcessedInThisBatch = sequenceNumber;
                                m_lastSequenceIdProcessedInThisBatch = sequenceId;
                            }

                            return continueProcessingImages(params, resolve, reject);
                        }}(sequenceNumber, sequenceId)
                    );
            }
        }}(id), function(reason) {
            console.log("OCR Call failed.", reason);
            reject(reason);
        });
    }
}

//it´s in fact an insert
function updateLastRetrievedSequenceId(params, reject) {
    m_currentSequenceNumberProcessedInThisBatch = m_lastSequenceNumberProcessedInThisBatch;
    var id = m_lastSequenceIdProcessedInThisBatch;
    var num = m_lastSequenceNumberProcessedInThisBatch;
    return new Promise(function() {
        var url = "http://" + params.CLOUDANT_HOST + "/" + params.CLOUDANT_LAST_SEQUENCE_DATABASE;
        request({
            uri: url,
            method: "POST",
            json: true,
            body: {
                lastSequenceIdentifier: id,
                lastSequenceNumber: num
            }
        }, function(error, incomingMessage, response) {
            if (error) {
                console.log("Update of lastSequenceId failed:", id, error);
                reject(error);
            }
        });
    });
}

function insertRejectedCheckInfo(params, idParsedRecord, email, toAccount, amount) {
    return new Promise(function(resolve, reject) {
        var timestamp = parseInt((new Date).getTime() / 1000, 10);    
        console.log('Inserting in REJECTEDDB, id ' + idParsedRecord + ", amount = " + amount);

        var url = "http://" + params.CLOUDANT_HOST + "/" + params.CLOUDANT_PARSED_DATABASE;
        request({
            uri: url,
            method: "POST",
            json: true,
            body: {
                _id: idParsedRecord,
                toAccount: toAccount,
                fromAccount: -1,
                routingNumber: -1,
                email: email,
                amount: amount,
                timestamp: timestamp
            }
        }, function(error, incomingMessage, response) {
            if (incomingMessage.statusCode == 409) {
                console.log("Rejected Record already existed:", idParsedRecord);
                resolve(response);
            } else if (error) {
                console.log("Creation of rejected record failed:", idParsedRecord, error);
                reject(error);
            } else {
                resolve(response);
            }
        });
    });
}

function insertProcessedCheckInfo(params, bankingInfo, idParsedRecord, email, toAccount, amount) {
    return new Promise(function(resolve, reject) {
        var timestamp = parseInt((new Date).getTime() / 1000, 10);
        
        var fromAccount = bankingInfo.accountNumber;
        var routingNumber = bankingInfo.routingNumber;

        console.log('Inserting in PARSEDDB, id ' + idParsedRecord + ", amount = " + amount);
        
        var url = "http://" + params.CLOUDANT_HOST + "/" + params.CLOUDANT_PARSED_DATABASE;
        request({
            uri: url,
            method: "POST",
            json: true,
            body: {
                _id: idParsedRecord,
                toAccount: toAccount,
                fromAccount: fromAccount,
                routingNumber: routingNumber,
                email: email,
                amount: amount,
                timestamp: timestamp
            }
        }, function(error, incomingMessage, response) {
            if (incomingMessage.statusCode == 409) {
                console.log("Processed record already existed:", idParsedRecord);
                resolve(response);
            } else if (error) {
                console.log("Creation of processed record failed:", idParsedRecord, error);
                reject(error);
            } else {
                resolve(response);
            }
        });
    });
}

/**
 * @param  {string} routingNumber
 * @param  {string} accountNumber
 * @class
 */
function BankCheckMicrInformation(routingNumber, accountNumber) {
  this.routingNumber = routingNumber;
  this.accountNumber = accountNumber;
  this.invalid = function () {
    return this.routingNumber.length != 9 || this.accountNumber.length === 2;
  }
}

/**
 * @param  {string} micrCheckRawInformation
 * @return {BankCheckMicrInformation}
 */
function parseMicrDataToBankingInformation(micrCheckRawInformation) {
  if (typeof micrCheckRawInformation !== "string")
    throw new Error("Invalid Micr information");
  if (micrCheckRawInformation.length === 0)
    throw new Error("Invalid Micr information");

  var routingRegExp = /\[\d{9}\[/gm;
  var routingMatches = micrCheckRawInformation.match(routingRegExp);
  if (routingMatches === null || routingMatches.length === 0)
    return new BankCheckMicrInformation("-1", "0");
  if (routingMatches.length > 1)
    return new BankCheckMicrInformation("-2", "0");
  var routingNumber = routingMatches[0].substring(1, 10);

  var accountRegExp = /(\[\d{9}\[)( ?)([0-9A-Z]+@)/igm;
  var accountMatches = accountRegExp.exec(micrCheckRawInformation);

  //console.log("Matches for account number: ");
  //console.log(accountMatches);
  if (accountMatches === null || accountMatches.length === 0)
    return new BankCheckMicrInformation(routingNumber, "-1");
  if (accountMatches.length > 4)
    return new BankCheckMicrInformation(routingNumber, "-2");
  var accountNumber = accountMatches[3].replace("@", "");

  return new BankCheckMicrInformation(routingNumber, accountNumber);
}
