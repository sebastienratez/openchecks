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
var request = require('request');
/**
 * This action is triggered by a new check image added to a CouchDB database.
 * This action is idempotent. If it fails, it can be retried.
 *
 * 1. Fetch the record from the 'audited' database and find its attachment along with
 *    deposit to and account information.
 * 2. Process the image for deposit to account, routing number and move it to
 *    another 'parsed' database with metadata and a confidence score.
 *
 * @param   params.CLOUDANT_REMOTE_USER              Cloudant username for bluemix
 * @param   params.CLOUDANT_REMOTE_PASS              Cloudant password for bluemix
 * @param   params.CLOUDANT_REMOTE_HOST              host:port of the http cloudant database for bluemix
 * @param   params.CLOUDANT_STATISTICS_DATABASE  Cloudant database to store the stats on bluemix
 * @return                                    Promise
 */
function main(params) {
    console.log(params);
    //params.dbContent.rows contains all documents from the processed db on premises. We will build some dummy statistics 
    //in this procedure to simulate some sort of cpu operation that would justify cloud bursting.

    console.log("Entering statistics calculator. Documents Found: " + params.dbContent.rows.length);
    var totalCheques = params.dbContent.rows.length;
    var totalRejected = 0;
    var totalAccepted = 0;
    var totalAmount = 0;
    var totalAmountAccepted = 0;
    var totalAmountRejected = 0;
    
    params.dbContent.rows.forEach(function(processedDocument) {
        var doc = processedDocument.doc;
        var amount = parseFloat(doc.amount);
        if (amount == null || typeof(amount) == "undefined" || isNaN(amount)) amount = 0;
        if (typeof(doc.fromAccount) !== "undefined" && doc.fromAccount != -1) {
            totalAccepted++;
            totalAmountAccepted += amount;
        } else {
            totalRejected++;
            totalAmountRejected += amount;
        }
        
        totalAmount += amount;
    });
    
    //Done with the stats :-)
    //Post it to our "data warehouse"
    return new Promise(function(resolve, reject) {

        var url = "https://" + params.CLOUDANT_REMOTE_USER + ":" + params.CLOUDANT_REMOTE_PASS + "@" + params.CLOUDANT_REMOTE_HOST + "/" + params.CLOUDANT_STATISTICS_DATABASE;
        var ts = (new Date()).getTime();
        request({
            uri: url,
            method: "POST",
            json: true,
            body: {
                _id: "" + ts,
                totalCheques: totalCheques,
                totalRejected: totalRejected,
                totalAccepted: totalAccepted,
                totalAmount: totalAmount,
                totalAmountAccepted: totalAmountAccepted,
                totalAmountRejected: totalAmountRejected,
                calculatedFromHost: process.env.OW_API_HOST || process.env.__OW_API_HOST
            }
        }, function(error, incomingMessage, response) {
            if (error) {
                reject(error);
            } else {
                console.log(response);
                console.log("Done! Timestamp ms was", ts);
                resolve({ done: true });
            }
        });
    });
}
