(function () {
  try {
    fetch("http://127.0.0.1:8000/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level: "info",
        src: "page",
        url: location.href,
        msg: "bookmarklet ping",
      }),
    })
      .then(function (r) { alert("jobs ping: " + r.status); })
      .catch(function (e) { alert("jobs ping FAILED: " + e); });
  } catch (e) {
    alert("jobs ping threw: " + e);
  }
})();
