(function(){
  fetch("http://127.0.0.1:8000/log",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({level:"info",src:"page",url:location.href,msg:"ping from page fetch"})}).then(()=>console.log("ping ok")).catch(e=>console.log("ping fail",e));
})();
