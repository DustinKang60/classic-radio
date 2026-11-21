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

  var turn = 0;

  /*
    방송사가 주는 주소는 두 가지다.

      ① 그대로 재생할 수 있는 재생목록 (.m3u8) — CBS · EBS
      ② "재생 주소를 알려주는 주소" — KBS · SBS · MBC

    ②를 그냥 재생기에 던지면 JSON 이나 글자를 받아들고 실패한다.
    (아이폰에서 CBS 만 나오고 나머지가 안 되던 것이 이것 때문이었다)
    그래서 ②는 한 번 받아서 안쪽 주소를 꺼낸다.

    안쪽 주소는 전부 시한부다(KBS 는 CloudFront 서명, SBS 는 JWT, MBC 는 자체 토큰).
    그러니 재생할 때마다 새로 받아야 한다. 저장해두면 몇 시간 뒤에 죽는다.
  */
  function resolve(url) {
    if (url.indexOf(".m3u8") !== -1) return Promise.resolve(url);

    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    }).then(function (body) {
      // KBS 는 JSON 으로 답한다
      if (url.indexOf("kbs.co.kr") !== -1) {
        var d = JSON.parse(body);
        var item = d.channel_item && d.channel_item[0];
        var u = item && item.service_url;
        if (!u) throw new Error("KBS 주소 없음");
        return u;
      }
      // SBS · MBC 중계는 본문 한 줄이 그대로 주소다
      var t = body.trim().split(/\r?\n/)[0].trim();
      if (t.indexOf("http") !== 0) throw new Error("주소 아님");
      return t;
    });
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

      var myTurn = ++turn;   // 그새 다른 방송을 골랐으면 이 요청은 버린다

      function started() { if (myTurn === turn) { playing = true; buffering = false; } }
      function failed(msg) {
        if (myTurn !== turn) return;
        lastError = msg || "방송을 열 수 없다"; playing = false; buffering = false;
      }

      function open(real) {
        if (myTurn !== turn) return;
        if (window.Hls && window.Hls.isSupported()) {
          hls = new Hls({ enableWorker: true, lowLatencyMode: false });
          hls.loadSource(real);
          hls.attachMedia(audio);
          hls.on(Hls.Events.MANIFEST_PARSED, function () {
            audio.play().then(started).catch(function () { failed("재생이 막혔다 — 화면을 한 번 눌러주세요"); });
          });
          hls.on(Hls.Events.ERROR, function (_, d) {
            if (d && d.fatal) failed("방송 신호가 끊겼다");
          });
        } else {
          // 사파리는 HLS 를 스스로 재생한다. hls.js 가 안 되는 기기에서의 대비책.
          audio.src = real;
          audio.play().then(started).catch(function () { failed("재생이 막혔다 — 화면을 한 번 눌러주세요"); });
        }
      }

      resolve(url).then(open).catch(function () { failed("방송 주소를 받아오지 못했다"); });
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
    _resolveForTest: resolve,   /* 시험용 창구 */
    meterMode: function () {},     // 통로가 하나뿐이라 구분할 필요가 없다
    level:     function () { return lvl; },
    levelLive: function () { return live; }
  };
})();
