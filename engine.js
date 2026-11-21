/* ══════════════════════════════════════════════════════════════
   소리 엔진 — 아이폰판

   안드로이드판은 이 자리에 네이티브(SemFmPlayer·StreamService)가 있었다.
   아이폰에는 그런 것이 없으니 웹 기술로 같은 창구를 만든다.
   창구 이름과 모양을 그대로 맞춰서, 화면 코드는 한 줄도 안 고친다.

   ── 왜 Web Audio 를 거치나 ──
   아이폰은 audio.volume 을 무시한다. 옆면 버튼으로만 소리가 조절된다.
   그런데 Web Audio 안의 GainNode 는 듣는다. 그래서 소리를 한 번 거쳐 보낸다.
       audio → MediaElementSource → GainNode → AnalyserNode → 출력
   볼륨 노브가 GainNode 에, SIGNAL 바늘이 AnalyserNode 에 붙는다.

   ── 아이폰의 함정 ──
   사파리가 HLS 를 "자체 경로" 로 재생해 버리면, 소리는 나는데 Web Audio 에는
   빈 소리만 들어온다. 그러면 음량 조절도 안 먹고 바늘도 안 움직인다.
   이를 피하려면 hls.js(MSE) 로 우리가 직접 풀어 먹여야 한다.
   그래서 아래 preferManagedMediaSource 로 hls.js 를 붙들고,
   그래도 소리가 통로에 안 들어오면 스스로 알아채고 물러난다(watchdog).
   ══════════════════════════════════════════════════════════════ */

var N = (function () {

  var ctx = null, gain = null, analyser = null, wave = null;
  var audio = null;        // 지금 소리를 내는 element
  var graphed = false;     // 이 element 가 Web Audio 통로에 물려 있나
  var webAudioOk = false;  // 통로로 소리가 실제로 들어오나
  var hls = null;
  var vol = 0.55;
  var playing = false, buffering = false, lastError = "";
  var lvl = 0;
  var turn = 0;
  var watchdog = 0;

  function newAudio() {
    var a = new Audio();
    a.crossOrigin = "anonymous";   // 없으면 Web Audio 가 소리를 못 받는다
    a.preload = "none";
    a.volume = vol;                // 안드로이드 크롬 등에서는 이쪽도 듣는다
    return a;
  }

  /* 아이폰은 사용자가 화면을 건드린 뒤에만 소리를 낸다. 그래서 첫 조작 때 만든다. */
  function ensureCtx() {
    if (ctx) return true;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      gain = ctx.createGain();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      wave = new Uint8Array(analyser.fftSize);
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      gain.gain.value = vol;
      measure();
      return true;
    } catch (e) {
      ctx = null;
      return false;
    }
  }

  function measure() {
    if (!analyser) return;
    if (graphed) {
      analyser.getByteTimeDomainData(wave);
      var sum = 0;
      for (var i = 0; i < wave.length; i++) { var v = (wave[i] - 128) / 128; sum += v * v; }
      var rms = Math.sqrt(sum / wave.length);
      if (rms > 0.0008) webAudioOk = true;
      var db = 20 * Math.log10(Math.max(rms, 1e-5));
      lvl = Math.max(0, Math.min(1, (db + 50) / 50));
    }
    requestAnimationFrame(measure);
  }

  /*
    방송사가 주는 주소는 두 가지다.
      ① 그대로 재생할 수 있는 재생목록(.m3u8) — CBS · EBS
      ② "재생 주소를 알려주는 주소" — KBS · SBS · MBC
    ②는 한 번 받아 안쪽 주소를 꺼낸다. 안쪽 주소는 전부 시한부라
    (KBS CloudFront 서명 · SBS JWT · MBC 자체 토큰) 재생할 때마다 새로 받아야 한다.
  */
  function resolve(url) {
    if (url.indexOf(".m3u8") !== -1) return Promise.resolve(url);
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    }).then(function (body) {
      if (url.indexOf("kbs.co.kr") !== -1) {
        var d = JSON.parse(body);
        var item = d.channel_item && d.channel_item[0];
        if (!item || !item.service_url) throw new Error("KBS 주소 없음");
        return item.service_url;
      }
      var t = body.trim().split(/\r?\n/)[0].trim();
      if (t.indexOf("http") !== 0) throw new Error("주소 아님");
      return t;
    });
  }

  function canUseHls() {
    if (!window.Hls) return false;
    if (Hls.isSupported()) return true;
    // iOS 17.1+ 는 ManagedMediaSource 가 있다. isSupported 가 머뭇거려도 밀어붙인다.
    return typeof window.ManagedMediaSource !== "undefined";
  }

  function teardown() {
    clearTimeout(watchdog); watchdog = 0;
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (audio) {
      try { audio.pause(); } catch (e) {}
      try { audio.removeAttribute("src"); audio.load(); } catch (e) {}
    }
    playing = false; buffering = false; lvl = 0;
  }

  /* 실제 재생. graph 가 true 면 Web Audio 통로에 물려서 낸다. */
  function start(real, useGraph, myTurn, onFail, onPlaying) {
    audio = newAudio();
    graphed = false;

    if (useGraph && ensureCtx()) {
      try {
        ctx.createMediaElementSource(audio).connect(gain);
        graphed = true;
        if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
      } catch (e) {
        graphed = false;   // 통로에 못 물리면 그냥 element 로 낸다
      }
    }

    function ok() {
      if (myTurn !== turn) return;
      playing = true; buffering = false;
      if (onPlaying) onPlaying();
    }

    if (canUseHls()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        preferManagedMediaSource: true   // 사파리 자체 경로로 새지 않게 붙든다
      });
      hls.loadSource(real);
      hls.attachMedia(audio);
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        audio.play().then(ok).catch(function () { onFail("재생이 막혔다 — 화면을 한 번 눌러주세요"); });
      });
      hls.on(Hls.Events.ERROR, function (_, d) {
        if (d && d.fatal) onFail("방송 신호가 끊겼다");
      });
    } else {
      audio.src = real;
      audio.play().then(ok).catch(function () { onFail("재생이 막혔다 — 화면을 한 번 눌러주세요"); });
    }
  }

  return {
    present: true,

    /* ── 전파(AIR) ──
       아이폰은 FM 수신기를 열어주지 않는다. 기기가 없어서가 아니라
       애플이 쓰게 해준 적이 없다. 전부 "없음" 으로 답하면
       화면이 알아서 전원 꺼짐 상태로 남는다. */
    fmReady:  function () { return false; },
    fmAlive:  function () { return false; },
    fmStart:  function () { return false; },
    fmStop:   function () {},
    fmFreq:   function () { return 0; },
    fmTune:   function () {},
    fmSignal: function () { return 0; },
    fmLabel:  function () { return ""; },

    /* 취침 타이머는 뺐다. 화면을 끄면 웹의 시계가 멎어 정작 자야 할 때 안 꺼진다. */
    sleepSet:  function () {},
    sleepLeft: function () { return 0; },

    streamPlay: function (url) {
      lastError = "";
      teardown();
      buffering = true;
      var myTurn = ++turn;

      function failed(msg) {
        if (myTurn !== turn) return;
        lastError = msg || "방송을 열 수 없다";
        playing = false; buffering = false;
      }

      resolve(url).then(function (real) {
        if (myTurn !== turn) return;
        webAudioOk = false;

        /*
          통로에 소리가 들어오는지 지켜본다. 빈 소리뿐이면 사파리가 자체 경로로
          재생한 것이고, 그대로 두면 아무 소리도 안 날 위험이 있다. 그때는
          통로를 떼고 element 로 바로 낸다 — 음량·바늘은 포기하되 소리는 지킨다.

          ★ 시점이 중요하다. 전에는 재생을 걸고 3초 뒤에 봤는데, 폰에서는
            주소 받고 버퍼링하는 데 그보다 오래 걸린다. 그래서 아직 소리가
            시작도 안 했는데 "안 들어온다" 고 단정하고 멀쩡한 통로를 떼어냈다.
            이제는 재생이 실제로 시작된 뒤, 소리가 흐르고 있는지까지 확인하고 본다.
        */
        function watch() {
          clearTimeout(watchdog);
          watchdog = setTimeout(function () {
            if (myTurn !== turn) return;
            if (!graphed || webAudioOk) return;          // 통로가 잘 돌고 있다
            if (!audio) return;
            // 아직 소리가 안 나왔으면 판단하지 않고 더 기다린다
            if (audio.paused || audio.currentTime < 1) { watch(); return; }
            teardown();
            turn = myTurn;                                // 같은 요청의 연장이다
            start(real, false, myTurn, failed, null);
          }, 5000);
        }

        start(real, true, myTurn, failed, watch);
      }).catch(function () { failed("방송 주소를 받아오지 못했다"); });
    },

    streamStop:      function () { turn++; teardown(); },
    streamPlaying:   function () { return playing; },
    streamBuffering: function () { return buffering; },
    streamError:     function () { var e = lastError; lastError = ""; return e; },

    /* ── 소리 크기 ──
       통로에 물려 있으면 GainNode 로(아이폰에서도 듣는다),
       아니면 element 음량으로(아이폰은 무시, 안드로이드는 듣는다). */
    setVolume: function (v) {
      vol = Math.max(0, Math.min(1, v));
      if (gain) gain.gain.value = vol;
      if (audio) { try { audio.volume = vol; } catch (e) {} }
    },
    getVolume: function () { return vol; },

    /* ── 계기 바늘 ──
       통로로 진짜 소리가 들어올 때만 "살아 있다" 고 답한다.
       아니면 화면이 알아서 다른 기준으로 바늘을 움직인다. */
    meterMode: function () {},
    level:     function () { return lvl; },
    levelLive: function () { return graphed && webAudioOk; }
  };
})();
