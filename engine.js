/* ══════════════════════════════════════════════════════════════
   소리 엔진 — 아이폰판

   안드로이드판은 이 자리에 네이티브(SemFmPlayer·StreamService)가 있었다.
   아이폰에는 그런 것이 없으니 웹 기술로 같은 창구를 만든다.
   창구 이름과 모양을 그대로 맞춰서, 나머지 화면 코드는 한 줄도 안 고친다.

   핵심은 Web Audio 를 한 번 거치는 것이다.
     audio → MediaElementSource → GainNode → AnalyserNode → 출력
   아이폰은 audio.volume 을 무시하지만 GainNode 는 듣는다. 볼륨 노브가 여기 붙는다.
   AnalyserNode 로 파형을 읽어 SIGNAL 바늘을 흔든다.

   방송사가 소리 데이터를 열어줘야(CORS) 이 통로가 열린다.
   KBS·SBS·CBS·EBS 는 열려 있는 것을 확인했다. MBC 는 막혀 있어 목록에서 뺐다.
   ══════════════════════════════════════════════════════════════ */

var N = (function () {

  var audio = new Audio();
  audio.crossOrigin = "anonymous";   // 이게 없으면 Web Audio 가 소리를 못 받는다
  audio.preload = "none";

  var ctx = null, gain = null, analyser = null, wave = null;
  var hls = null;
  var vol = 0.55;
  var playing = false, buffering = false, lastError = "";
  var lvl = 0, live = false;

  /* 아이폰은 사용자가 화면을 건드린 뒤에만 소리를 낸다.
     그래서 그래프는 첫 조작 때 만든다. */
  function graph() {
    if (ctx) return true;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      var src = ctx.createMediaElementSource(audio);
      gain = ctx.createGain();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      wave = new Uint8Array(analyser.fftSize);
      src.connect(gain); gain.connect(analyser); analyser.connect(ctx.destination);
      gain.gain.value = vol;
      measure();
      return true;
    } catch (e) {
      lastError = "소리 장치를 열지 못했다";
      ctx = null;
      return false;
    }
  }

  function measure() {
    if (!analyser) return;
    analyser.getByteTimeDomainData(wave);
    var sum = 0;
    for (var i = 0; i < wave.length; i++) { var v = (wave[i] - 128) / 128; sum += v * v; }
    var rms = Math.sqrt(sum / wave.length);
    if (rms > 0.0001) live = true;
    var db = 20 * Math.log10(Math.max(rms, 1e-5));
    lvl = Math.max(0, Math.min(1, (db + 50) / 50));
    requestAnimationFrame(measure);
  }

  function stopStream() {
    playing = false; buffering = false;
    try { audio.pause(); } catch (e) {}
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    audio.removeAttribute("src");
    live = false; lvl = 0;
  }

  return {
    present: true,

    /* ── 전파(AIR) ──
       아이폰은 FM 수신기를 열어주지 않는다. 기기가 없는 것이 아니라
       애플이 쓰게 해준 적이 없다. 그래서 전부 "없음" 으로 답한다.
       화면은 이 답을 보고 알아서 전원 꺼짐 상태로 남는다. */
    fmReady:  function () { return false; },
    fmAlive:  function () { return false; },
    fmStart:  function () { return false; },
    fmStop:   function () {},
    fmFreq:   function () { return 0; },
    fmTune:   function () {},
    fmSignal: function () { return 0; },
    fmLabel:  function () { return ""; },

    /* 취침 타이머는 아이폰판에서 뺐다. 화면을 끄면 웹의 시계가 멈춰
       정작 자야 할 때 안 꺼지기 때문이다. */
    sleepSet:  function () {},
    sleepLeft: function () { return 0; },

    /* ── 인터넷 방송 ── */
    streamPlay: function (url, name) {
      lastError = "";
      stopStream();
      if (!graph()) return;
      if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
      buffering = true;

      function started() { playing = true; buffering = false; }
      function failed(msg) { lastError = msg || "방송을 열 수 없다"; playing = false; buffering = false; }

      if (window.Hls && window.Hls.isSupported()) {
        hls = new Hls({ enableWorker: true, lowLatencyMode: false });
        hls.loadSource(url);
        hls.attachMedia(audio);
        hls.on(Hls.Events.MANIFEST_PARSED, function () {
          audio.play().then(started).catch(function () { failed("재생이 막혔다 — 화면을 한 번 눌러주세요"); });
        });
        hls.on(Hls.Events.ERROR, function (_, d) {
          if (d && d.fatal) failed("방송 신호가 끊겼다");
        });
      } else {
        // 사파리는 HLS 를 스스로 재생한다. hls.js 가 안 되는 기기에서의 대비책.
        audio.src = url;
        audio.play().then(started).catch(function () { failed("재생이 막혔다 — 화면을 한 번 눌러주세요"); });
      }
    },

    streamStop:      function () { stopStream(); },
    streamPlaying:   function () { return playing; },
    streamBuffering: function () { return buffering; },
    streamError:     function () { var e = lastError; lastError = ""; return e; },

    /* ── 소리 크기 ──
       아이폰은 audio.volume 을 무시한다. GainNode 로 조절해야 한다. */
    setVolume: function (v) {
      vol = Math.max(0, Math.min(1, v));
      if (gain) gain.gain.value = vol;
      audio.volume = vol;          // 안드로이드 크롬 등에서는 이쪽도 듣는다
    },
    getVolume: function () { return vol; },

    /* ── 계기 바늘 ── */
    meterMode: function () {},     // 통로가 하나뿐이라 구분할 필요가 없다
    level:     function () { return lvl; },
    levelLive: function () { return live; }
  };
})();
