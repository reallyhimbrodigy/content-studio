const fs=require("fs"),crypto=require("crypto"),https=require("https");
const KID="6UXQ2STG2D", ISS="64bc4b23-6b09-469c-967c-8a87a619dacb";
const P8=fs.readFileSync(process.env.HOME+"/.appstoreconnect/private_keys/AuthKey_"+KID+".p8","utf8");
function jwt(){const n=Math.floor(Date.now()/1e3),b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
 const h=b({alg:"ES256",kid:KID,typ:"JWT"}),p=b({iss:ISS,iat:n,exp:n+900,aud:"appstoreconnect-v1"});
 return h+"."+p+"."+crypto.sign("SHA256",Buffer.from(h+"."+p),{key:P8,dsaEncoding:"ieee-p1363"}).toString("base64url");}
function req(method,path,body,extraHeaders,host){
 return new Promise((res,rej)=>{
  const data = body && !Buffer.isBuffer(body) ? Buffer.from(JSON.stringify(body)) : body;
  const headers = Object.assign({Authorization:"Bearer "+jwt()}, extraHeaders||{});
  if (data && !headers["Content-Type"]) headers["Content-Type"]="application/json";
  if (data) headers["Content-Length"]=data.length;
  const r=https.request({host:host||"api.appstoreconnect.apple.com",path,method,headers},resp=>{
    let d=[];resp.on("data",c=>d.push(c));resp.on("end",()=>{
      const raw=Buffer.concat(d).toString();
      try{res({status:resp.statusCode,body:JSON.parse(raw)})}catch(e){res({status:resp.statusCode,body:raw})}});
  });
  r.on("error",rej); if(data) r.write(data); r.end();});
}
module.exports={req};
