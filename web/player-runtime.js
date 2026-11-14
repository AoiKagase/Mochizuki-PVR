(function () {
  "use strict";

  function stopRequest(url) {
    if (!url) return Promise.resolve(true);
    var target;
    try { target = new URL(url, window.location.href); } catch (error) { return Promise.resolve(true); }
    if (target.origin !== window.location.origin || !/^\/api\/(?:recorded|recording|channel)\/[^/]+\/(?:hls\/index\.m3u8|watch\.(?:mp4|m2ts)|subtitles\.vtt)$/.test(target.pathname)) {
      return Promise.resolve(true);
    }
    // The server waits at most five seconds for teardown. A lost response
    // must not keep all future source changes waiting on the same promise.
    return new Promise(function (resolve) {
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      var settled = false;
      var timer = window.setTimeout(function () {
        finish(false);
        if (controller) controller.abort();
      }, 6000);
      function finish(ok) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(ok);
      }
      var options = { method: "DELETE", keepalive: true };
      if (controller) options.signal = controller.signal;
      Promise.resolve().then(function () { return fetch(target.toString(), options); }).then(function (response) {
        finish(response.ok);
      }, function () { finish(false); });
    });
  }

  function createRecovery(video, options) {
    var active = false;
    var stallTimer = 0;
    var retryTimer = 0;
    var attempts = 0;
    var lastTime = 0;
    var healthySince = null;
    var wantsPlayback = false;
    var userPaused = false;
    var hasStatus = false;

    function clearStall() {
      window.clearTimeout(stallTimer);
      stallTimer = 0;
    }
    function clearRetry() {
      window.clearTimeout(retryTimer);
      retryTimer = 0;
    }
    function enabled() { return active && options.enabled(); }
    function status(message, canRetry) {
      if (!message && !hasStatus) return;
      hasStatus = Boolean(message);
      options.status(message, Boolean(canRetry));
    }

    function fail(reason) {
      if (!enabled() || userPaused || retryTimer) return;
      clearStall();
      healthySince = null;
      if (attempts >= 5) {
        active = false;
        status("自動復帰できませんでした。接続を確認して再試行してください", true);
        return;
      }
      attempts += 1;
      status(reason + " 再接続しています（" + attempts + "/5）", false);
      retryTimer = window.setTimeout(function () {
        retryTimer = 0;
        if (enabled()) options.reload();
      }, Math.min(1000 * Math.pow(2, attempts - 1), 8000));
    }

    function waiting() {
      if (!enabled() || !wantsPlayback || video.paused || video.ended || retryTimer || stallTimer) return;
      lastTime = video.currentTime;
      healthySince = null;
      status("映像データを受信しています", false);
      stallTimer = window.setTimeout(function () {
        stallTimer = 0;
        if (!enabled() || !wantsPlayback || video.paused || video.ended) return;
        if (video.currentTime > lastTime + 0.1) { status(""); return; }
        fail("映像の受信が止まっています。");
      }, 12000);
    }

    video.addEventListener("play", function () { wantsPlayback = true; userPaused = false; });
    video.addEventListener("pause", function () {
      // Native players also pause when decoding/network errors end playback.
      // That event must not cancel the reconnect scheduled by the error handler.
      if (video.error || video.ended) return;
      wantsPlayback = false;
      if (active && !video.ended) userPaused = true;
      clearStall();
      clearRetry();
    });
    video.addEventListener("waiting", waiting);
    video.addEventListener("stalled", waiting);
    video.addEventListener("playing", function () {
      if (!enabled()) return;
      clearStall();
      // A late event from buffered frames cannot cancel a scheduled reconnect.
      if (!retryTimer) status("");
      healthySince = video.currentTime;
    });
    video.addEventListener("timeupdate", function () {
      if (!enabled() || retryTimer || video.paused) return;
      var current = video.currentTime;
      if (current > lastTime + 0.1) {
        clearStall();
        status("");
        if (healthySince === null) healthySince = current;
        if (current - healthySince >= 5) attempts = 0;
      }
      lastTime = current;
    });
    video.addEventListener("ended", function () {
      clearStall();
      if (enabled() && options.retryEnded()) fail("配信が中断されました。");
    });

    return {
      start: function (isRecovery) {
        clearStall();
        clearRetry();
        active = true;
        wantsPlayback = false;
        userPaused = false;
        hasStatus = false;
        healthySince = null;
        lastTime = 0;
        if (!isRecovery) attempts = 0;
      },
      cancel: function () {
        active = false;
        wantsPlayback = false;
        clearStall();
        clearRetry();
      },
      fail: fail
    };
  }

  window.MochizukiPlayer = { stopRequest: stopRequest, createRecovery: createRecovery };
})();
