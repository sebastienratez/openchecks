wsk action update /Irium_school/parse-check-data parse-check-data.js ^
    --param CLOUDANT_USER "b1a9198c-0a96-40e6-8f1a-de6dc25e88c7-bluemix" ^
    --param CLOUDANT_PASS "bf9f8aaf16b5bfae18e08ccedb4096f896184f5ce662163ed5559ba734f30d22" ^
    --param CLOUDANT_PARSED_DATABASE "parsed" ^
    --param CLOUDANT_AUDITED_DATABASE "audited" ^
    --param CLOUDANT_REJECTED_DATABASE "rejected" ^
    --param CURRENT_NAMESPACE "_"