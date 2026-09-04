// ATTACH AN IAP REVIEW SCREENSHOT, through the API rather than the uploader.
//
// Written because "the uploader rejects this size" was asserted about two
// sizes App Store Connect demonstrably stores — and the only way to settle
// that was to ask ASC directly rather than re-shoot a third time. It reserves,
// PUTs the bytes, commits with the checksum, then POLLS assetDeliveryState and
// prints ASC's own verdict: the stored dimensions and any errors.
//
// That last part is the point. A rejection message read off a screen is a
// report; `assetDeliveryState.errors` is the system's own answer about the
// exact bytes it received.
//
// usage: node asc-attach-iap-screenshot.js <file.png> <inAppPurchaseId> <fileName>
//
// Reversible: DELETE /v1/inAppPurchaseAppStoreReviewScreenshots/{id} removes
// it. Attaching one does NOT submit anything for review.

const fs=require("fs"),crypto=require("crypto"),https=require("https"),{URL}=require("url");
const {req}=require("./asc-api.js");
async function put(op, buf){
  const u=new URL(op.url);
  const headers={};
  for(const h of (op.requestHeaders||[])) headers[h.name]=h.value;
  headers["Content-Length"]=op.length;
  const slice=buf.slice(op.offset, op.offset+op.length);
  return new Promise((res,rej)=>{
    const r=https.request({host:u.hostname,path:u.pathname+u.search,method:op.method,headers},resp=>{
      let d=[];resp.on("data",c=>d.push(c));resp.on("end",()=>res({status:resp.statusCode,body:Buffer.concat(d).toString().slice(0,300)}));});
    r.on("error",rej); r.write(slice); r.end();});
}
(async()=>{
  const file=process.argv[2], iapId=process.argv[3], name=process.argv[4];
  const buf=fs.readFileSync(file);
  const md5=crypto.createHash("md5").update(buf).digest("hex");
  const r=await req("POST","/v1/inAppPurchaseAppStoreReviewScreenshots",{
    data:{type:"inAppPurchaseAppStoreReviewScreenshots",
      attributes:{fileName:name,fileSize:buf.length},
      relationships:{inAppPurchaseV2:{data:{type:"inAppPurchases",id:iapId}}}}});
  if(r.status!==201){console.log("reserve FAILED",r.status,JSON.stringify(r.body).slice(0,400));return;}
  const id=r.body.data.id;
  for(const op of r.body.data.attributes.uploadOperations){
    const p=await put(op,buf);
    if(p.status>=300){console.log("PUT failed",p.status,p.body);return;}
  }
  const patch=await req("PATCH","/v1/inAppPurchaseAppStoreReviewScreenshots/"+id,{
    data:{type:"inAppPurchaseAppStoreReviewScreenshots",id,attributes:{uploaded:true,sourceFileChecksum:md5}}});
  console.log("commit ->",patch.status);
  for(let i=0;i<12;i++){
    const g=await req("GET","/v1/inAppPurchaseAppStoreReviewScreenshots/"+id);
    const a=g.body.data && g.body.data.attributes;
    const st=a && a.assetDeliveryState;
    if(st && st.state!=="UPLOAD_COMPLETE"){
      console.log("STATE:",st.state,"| stored:",a.imageAsset.width+"x"+a.imageAsset.height,
                  "| errors:",JSON.stringify(st.errors),"| warnings:",JSON.stringify(st.warnings));
      if(st.state!=="PROCESSING") return {id, state:st.state};
    } else if(st) console.log("state:",st.state,"…");
    await new Promise(r=>setTimeout(r,5000));
  }
})();
