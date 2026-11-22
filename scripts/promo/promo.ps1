# ===== 时间管理助手 宣传演示（复制整段到 PowerShell，回车）=====
& {
$exe = Join-Path $env:LOCALAPPDATA 'Time Managing Assistant\personal-ai-desktop.exe'
if (-not (Test-Path $exe)) { Write-Host "没找到软件：$exe" -ForegroundColor Red; return }
Write-Host '1/4 关闭正在运行的软件……'
Get-Process personal-ai-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*Time Managing Assistant*' } | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*timemanagingassistant*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
$port = 9339
Write-Host '2/4 重新打开软件（可遥控模式）……'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port --remote-allow-origins=*"
Start-Process -FilePath $exe
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$target = $null
for ($i = 0; $i -lt 60 -and -not $target; $i++) {
  Start-Sleep -Seconds 1
  try { $target = (Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2) | Where-Object { $_.type -eq 'page' -and $_.url -notlike '*focus-mini*' } | Select-Object -First 1 } catch {}
}
if (-not $target) { Write-Host '没能连上软件窗口（调试端口没打开）。把这句话截图发给 Claude。' -ForegroundColor Red; return }
Write-Host "3/4 已连上：$($target.url)"
Write-Host '    软件已打开：现在把它最大化。软件里会倒数 10 秒，倒数时开始录屏。' -ForegroundColor Yellow
Start-Sleep -Seconds 4
$js = @'
(async () => {
  if (window.__demoRunning) return "already running";
  window.__demoRunning = true;
  let cancelled = false;
  addEventListener("keydown", (e) => { if (e.key === "Escape") cancelled = true; });
  const wait = (ms) => new Promise((ok, no) => setTimeout(() => cancelled ? no(new Error("stop")) : ok(), ms));
  const ease = (t) => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const css = document.createElement("style");
  css.textContent = `#demo-cursor{position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border:2px solid #160000;border-radius:50%;pointer-events:none;z-index:2147483647;transition:transform .12s,background-color .12s}
#demo-cursor.down{transform:scale(.72);background:rgba(22,0,0,.85)}
#demo-card{position:fixed;inset:0;z-index:2147483600;pointer-events:none;display:grid;place-content:center;justify-items:center;gap:24px;background:#120306;color:#ff4866;opacity:0;transition:opacity .45s}
#demo-card.on{opacity:1}
#demo-card b{font:400 clamp(64px,8vw,150px)/1 var(--font-display-zh);letter-spacing:.06em}
#demo-card small{font:500 clamp(14px,1.3vw,24px)/1.4 var(--font-mono);letter-spacing:.3em}
body.demo-playing *{cursor:none!important;user-select:none!important}`;
  document.head.appendChild(css);
  const cursor = document.createElement("div"); cursor.id = "demo-cursor";
  const at = { x: innerWidth / 2, y: innerHeight / 2 };
  const place = (x, y) => { at.x = x; at.y = y; cursor.style.left = x + "px"; cursor.style.top = y + "px";
    document.elementFromPoint(x, y)?.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true, pointerType: "mouse" })); };
  const glide = (x, y, ms = 700) => new Promise((ok, no) => { const f = { ...at }, s = performance.now();
    const step = (n) => { if (cancelled) return no(new Error("stop")); const t = Math.min(1, (n - s) / ms); place(f.x + (x - f.x) * ease(t), f.y + (y - f.y) * ease(t)); t < 1 ? requestAnimationFrame(step) : ok(); };
    requestAnimationFrame(step); });
  const glideTo = async (el, ms = 700, dx = .5, dy = .5) => { if (!el) return; el.scrollIntoView({ block: "nearest", behavior: "smooth" }); await wait(250); const b = el.getBoundingClientRect(); await glide(b.left + b.width * dx, b.top + b.height * dy, ms); };
  const click = async (el, ms = 650) => { if (!el) return; await glideTo(el, ms); cursor.classList.add("down"); await wait(120); cursor.classList.remove("down"); el.click(); };
  const scrollPage = (d, ms = 1200) => new Promise((ok) => { const f = scrollY, s = performance.now(); const step = (n) => { const t = Math.min(1, (n - s) / ms); scrollTo(0, f + d * ease(t)); t < 1 && !cancelled ? requestAnimationFrame(step) : ok(); }; requestAnimationFrame(step); });
  const card = async (big, small = "", hold = 1600) => { let el = document.getElementById("demo-card"); if (!el) { el = document.createElement("div"); el.id = "demo-card"; document.body.appendChild(el); }
    if (big !== null) { el.innerHTML = ""; const b = document.createElement("b"); b.textContent = big; const s = document.createElement("small"); s.textContent = small; el.append(b, s); requestAnimationFrame(() => el.classList.add("on")); await wait(hold); }
    el.classList.remove("on"); await wait(500); };
  const byText = (sel, text) => [...document.querySelectorAll(sel)].find((n) => n.textContent?.trim().startsWith(text)) ?? null;
  const nav = (label) => byText(".app-rail button", label) ?? byText(".mobile-nav button", label);
  try {
    // countdown: time to maximise the window and start recording
    let el = document.createElement("div"); el.id = "demo-card"; document.body.appendChild(el);
    const b = document.createElement("b"); b.textContent = "把一天排清楚"; const s = document.createElement("small"); el.append(b, s);
    requestAnimationFrame(() => el.classList.add("on"));
    for (let left = 10; left > 0; left--) { s.textContent = left + " 秒后开始 · 现在开始录屏"; await wait(1000); }
    s.textContent = "PLANNER · 时间管理助手";
    document.body.classList.add("demo-playing"); document.body.appendChild(cursor); place(innerWidth * .5, innerHeight * .55);
    await wait(1800); await card(null);

    await click(nav("今日")); await wait(900); scrollTo({ top: 0 });
    await glide(innerWidth * .5, innerHeight * .42, 700); await wait(500);
    const tl = document.querySelector(".day-grid");
    if (tl) await scrollPage(tl.getBoundingClientRect().top - 140, 1300);
    await click(byText("button", "全天")); await wait(700);
    for (const blk of [...document.querySelectorAll(".time-block")].slice(0, 3)) { await glideTo(blk, 600, .3, .45); await wait(350); }
    await card("排进时间轴", "拖一拖就排好 · 状态一眼看清", 1500);

    await click(nav("专注")); await wait(1100);
    const slip = document.querySelector(".focus-task-slip"); if (slip) { await click(slip); await wait(700); }
    scrollTo({ top: 0, behavior: "smooth" }); await wait(600);
    const tp = document.querySelector(".focus-timepiece");
    if (tp) { const bx = tp.getBoundingClientRect(), cx = bx.left + bx.width / 2;
      await glide(cx, bx.top + bx.height * .82, 700);
      for (let i = 0; i < 2; i++) { await glide(cx + 24, bx.top + bx.height * .22, 600); await wait(900); await glide(cx, bx.top + bx.height * .8, 900); await wait(300); }
      await wait(1000); }
    await card("留下真实记录", "每一分钟专注都会被看见", 1500);

    await click(nav("成长")); await wait(1300);
    await glide(innerWidth * .55, innerHeight * .5, 700);
    await scrollPage(520, 1800); await wait(900); await scrollPage(420, 1500); await wait(1100);

    await card("PLANNER", "github.com/wst-2006/Time-managing-assistant", 2600);
    scrollTo({ top: 0 }); await click(nav("今日"));
    return "done";
  } catch (e) { return "stopped"; }
  finally { document.getElementById("demo-card")?.remove(); cursor.remove(); css.remove(); document.body.classList.remove("demo-playing"); window.__demoRunning = false; }
})()

'@
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
$message = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $js; awaitPromise = $true } } | ConvertTo-Json -Depth 5 -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($message)
$ws.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
Write-Host '4/4 演示开始（按 Esc 可中止）。播放约 45 秒……'
$buffer = New-Object byte[] 65536
$segment = [ArraySegment[byte]]::new($buffer)
$reply = ''
do {
  $result = $ws.ReceiveAsync($segment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $reply += [Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
} while (-not $result.EndOfMessage)
$ws.Dispose()
if ($reply -match '"value":"done"') { Write-Host '演示结束，可以停止录屏。' -ForegroundColor Green } else { Write-Host "演示结束：$reply" }
}
