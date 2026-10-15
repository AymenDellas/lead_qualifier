'use strict';
function nameParts(input){
 const clean=v=>String(v||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 const first=clean(input.firstName).replace(/^(?:dr\.?|prof\.?)\s+/,'').split(/[\s(]/)[0].replace(/[^a-z]/g,'');
 const last=clean(input.lastName).split(/[,|]|\s+-\s+/)[0].replace(/\([^)]*\)/g,'').replace(/\b(?:icf|pcc|acc|mcc|phd|mba|cpcc|esq)\b/g,'').replace(/[^a-z]/g,'');
 return {first,last};
}
function personEmail(address,input){
 const {first,last}=nameParts(input),local=String(address||'').split('@')[0].toLowerCase(),flat=local.replace(/[^a-z]/g,'');
 if(first.length<2)return false;
 const words=local.split(/[^a-z]+/).filter(Boolean);
 const camelInitials=(String(input.firstName||'').match(/[A-Z]/g)||[]).join('').toLowerCase();
 return (first.length>=3&&(words.includes(first)||flat===first||last.length>=2&&[first+last,last+first].includes(flat)))
  ||last.length>=3&&[first[0]+last,last+first[0],first[0]+last[0]].includes(flat)
  ||camelInitials.length===2&&flat===camelInitials;
}
module.exports={nameParts,personEmail};
