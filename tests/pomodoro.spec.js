// Tests de bout en bout du minuteur. L'horloge du navigateur est simulée : 25 minutes passent en un instant.
const base = require('@playwright/test');
const { expect } = base;

const NOW = new Date('2026-10-01T10:00:00+02:00').getTime();

const test = base.test.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await page.route(/supabase\.co/, r => r.fulfill({ status: 200, body: '{}' }));
    await page.clock.install({ time: NOW });
    await use(page);
    expect(errors, 'erreurs JavaScript').toEqual([]);
  },
});

// Réglages et état de départ, posés une seule fois (pas à chaque rechargement).
async function open(page, { cfg, state, url = '/' } = {}) {
  await page.addInitScript(([c, s]) => {
    if (sessionStorage.getItem('seeded')) return;
    localStorage.clear();
    if (c) localStorage.setItem('pomodoro', JSON.stringify(c));
    if (s) localStorage.setItem('pomodoro-state', JSON.stringify(s));
    sessionStorage.setItem('seeded', '1');
  }, [cfg || null, state || null]);
  await page.goto(url);
}
const time = page => page.locator('#sr');
const toggle = page => page.locator('#toggle');
const phaseOn = page => page.locator('.phases button[aria-pressed=true]');
const later = (page, ms) => page.clock.fastForward(ms);

test('affiche 25:00 puis décompte', async ({ page }) => {
  await open(page);
  await expect(time(page)).toHaveText('25:00');
  await expect(toggle(page)).toHaveText('Démarrer');
  await toggle(page).click();
  await expect(toggle(page)).toHaveText('Pause');
  await later(page, 60_000);
  await expect(time(page)).toHaveText('24:00');
  await expect(page).toHaveTitle('24:00 · Focus');
});

test('enchaîne Focus, pause courte, Focus, pause longue', async ({ page }) => {
  await open(page, { cfg: { work: 1, short: 1, long: 2, every: 2 } });
  await toggle(page).click();
  await later(page, 61_000);
  await expect(phaseOn(page)).toHaveText('Pause courte');
  await expect(page.locator('#dots b')).toHaveText('1 terminée');
  await expect(toggle(page)).toHaveText('Pause');
  await later(page, 60_000);
  await expect(phaseOn(page)).toHaveText('Focus');
  await later(page, 60_000);
  await expect(phaseOn(page)).toHaveText('Pause longue');
  await expect(page.locator('#dots b')).toHaveText('2 terminées');
  await expect(time(page)).toHaveText(/^0[12]:\d\d$/);
});

test('sans enchaînement, la phase suivante attend', async ({ page }) => {
  await open(page, { cfg: { work: 1, auto: false } });
  await toggle(page).click();
  await later(page, 61_000);
  await expect(phaseOn(page)).toHaveText('Pause courte');
  await expect(toggle(page)).toHaveText('Démarrer');
  await expect(time(page)).toHaveText('05:00');
});

test('pause et reprise gardent le temps restant', async ({ page }) => {
  await open(page);
  await toggle(page).click();
  await later(page, 10_000);
  await toggle(page).click();
  await expect(toggle(page)).toHaveText('Reprendre');
  const frozen = await time(page).textContent();
  await later(page, 30_000);
  await expect(time(page)).toHaveText(frozen);
  await toggle(page).click();
  await expect(toggle(page)).toHaveText('Pause');
});

test('passer et recommencer', async ({ page }) => {
  await open(page);
  await page.locator('#skip').click();
  await expect(phaseOn(page)).toHaveText('Pause courte');
  await expect(time(page)).toHaveText('05:00');
  await toggle(page).click();
  await later(page, 20_000);
  await page.locator('#reset').click();
  await expect(time(page)).toHaveText('05:00');
  await expect(toggle(page)).toHaveText('Démarrer');
});

test('le décompte reprend après fermeture de la page', async ({ page }) => {
  await open(page);
  await toggle(page).click();
  await later(page, 5 * 60_000);
  await page.reload();
  await expect(time(page)).toHaveText('20:00');
  await expect(toggle(page)).toHaveText('Pause');
  await later(page, 60_000);
  await expect(time(page)).toHaveText('19:00');
});

test('rattrape les phases écoulées pendant la fermeture', async ({ page }) => {
  await open(page, {
    cfg: { work: 1, short: 1 },
    state: { phase: 'work', done: 0, total: 60_000, left: 60_000, endAt: NOW - 90_000, running: true,
      over: false, overStart: 0, day: new Date(NOW).toDateString() },
  });
  // Focus fini il y a 90 s, pause de 60 s finie il y a 30 s : nouveau Focus avec 30 s restantes.
  await expect(phaseOn(page)).toHaveText('Focus');
  await expect(time(page)).toHaveText('00:30');
  await expect(page.locator('#dots b')).toHaveText('1 terminée');
});

test('mode flow : le Focus continue au-delà de la fin', async ({ page }) => {
  await open(page, { cfg: { work: 1, flow: true } });
  await toggle(page).click();
  await later(page, 65_000);
  await expect(time(page)).toHaveText(/^\+00:0[4-6]$/);
  await expect(toggle(page)).toHaveText('Terminer');
  await toggle(page).click();
  await expect(phaseOn(page)).toHaveText('Pause courte');
});

test('mini-lecteur : piste silencieuse et infos de lecture pendant tout le décompte', async ({ page }) => {
  await open(page, { cfg: { work: 1, media: true } });
  await toggle(page).click();
  const media = () => page.evaluate(() => ({ title: navigator.mediaSession.metadata?.title, state: navigator.mediaSession.playbackState }));
  await expect.poll(async () => (await media()).title).toMatch(/^Focus · fin à \d\d:\d\d$/);
  expect((await media()).state).toBe('playing');
  await later(page, 61_000);
  await expect.poll(async () => (await media()).title).toMatch(/^Pause courte · fin à/);
  await toggle(page).click();
  await expect.poll(async () => (await media()).title).toBe('Pause courte en pause');
  expect((await media()).state).toBe('paused');
});

test('masquer les secondes', async ({ page }) => {
  await open(page, { cfg: { hideSec: true } });
  await expect(time(page)).toHaveText('25');
});

test("raccourci d'app : ?start=work&min=50", async ({ page }) => {
  await open(page, { url: '/?start=work&min=50' });
  await expect(time(page)).toHaveText('50:00');
  await expect(toggle(page)).toHaveText('Pause');
  expect(new URL(page.url()).search).toBe('');
});

test('réglages : durée, formule perso, palette', async ({ page }) => {
  await open(page);
  await page.locator('#openSettings').click();
  await page.locator('[data-step="work,1"]').click();
  await expect(time(page)).toHaveText('26:00');
  await page.locator('#addPreset').click();
  await expect(page.locator('#presets [data-c="0"]')).toHaveClass(/on/);
  await page.locator('[data-tab=look]').click();
  await page.locator('.swatch[data-v=corail]').click();
  await expect(page.locator('body')).toHaveCSS('--field', '#FF8A6B');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pomodoro')));
  expect(saved.work).toBe(26);
  expect(saved.presets).toEqual([[26, 5, 15, 4]]);
  expect(saved.palette).toBe('corail');
});

test('chaque option se coche et se décoche', async ({ page }) => {
  await open(page);
  await page.locator('#openSettings').click();
  for (const tab of ['timer', 'sound', 'pause', 'look', 'device']) {
    await page.locator(`[data-tab=${tab}]`).click();
    for (const sw of await page.locator(`[data-panel=${tab}] input.switch[data-k]:visible`).all()) {
      const k = await sw.getAttribute('data-k');
      const before = await sw.isChecked();
      await sw.click();
      expect(await page.evaluate(k => JSON.parse(localStorage.getItem('pomodoro'))[k], k)).toBe(!before);
      await sw.click();
      expect(await page.evaluate(k => JSON.parse(localStorage.getItem('pomodoro'))[k], k)).toBe(before);
    }
  }
});

test("la mise en page tient dans l'écran", async ({ page }) => {
  await open(page);
  const box = sel => page.locator(sel).first().boundingBox();
  const vp = page.viewportSize();
  const [dots, digits, caption, controls] = await Promise.all([box('#dots'), box('#above .digits'), box('#above .caption'), box('.controls')]);
  expect(digits.y).toBeGreaterThan(dots.y + dots.height);
  expect(controls.y).toBeGreaterThan(caption.y + caption.height);
  expect(controls.y + controls.height).toBeLessThanOrEqual(vp.height);
  expect(digits.x).toBeGreaterThanOrEqual(0);
  expect(digits.x + digits.width).toBeLessThanOrEqual(vp.width);
});

// Verrou d'écran simulé : on note chaque demande et chaque libération.
async function fakeWakeLock(page) {
  await page.addInitScript(() => {
    window.__wake = { held: 0, requests: 0 };
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
      request: async () => {
        window.__wake.requests++; window.__wake.held++;
        const l = new EventTarget();
        l.release = async () => { window.__wake.held--; l.dispatchEvent(new Event('release')); };
        return l;
      },
    } });
  });
}
const wakeHeld = page => page.evaluate(() => window.__wake.held);

test('écran allumé : pendant le décompte seulement', async ({ page }) => {
  await fakeWakeLock(page);
  await open(page);
  await page.waitForTimeout(50);
  expect(await wakeHeld(page)).toBe(0);
  await toggle(page).click();
  await expect.poll(() => wakeHeld(page)).toBe(1);
  await toggle(page).click();
  await expect.poll(() => wakeHeld(page)).toBe(0);
});

test('écran allumé : toujours, même minuteur arrêté', async ({ page }) => {
  await fakeWakeLock(page);
  await open(page, { cfg: { awake: true } });
  await page.locator('#openSettings').click();
  await page.locator('[data-tab=device]').click();
  await expect(page.locator('#awake .chip.on')).toHaveText('Pendant le décompte');
  await page.locator('#awake .chip[data-v=always]').click();
  await expect.poll(() => wakeHeld(page)).toBe(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pomodoro')).awake)).toBe('always');
  await page.locator('#awake .chip[data-v=off]').click();
  await expect.poll(() => wakeHeld(page)).toBe(0);
});

test('écran allumé : vidéo muette de secours si le verrou est refusé', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: () => Promise.reject(new Error('refusé')) } });
    HTMLMediaElement.prototype.play = function () { window.__played = this.currentSrc || this.src; return Promise.resolve(); };
  });
  await open(page, { cfg: { awake: 'always' } });
  await expect.poll(() => page.evaluate(() => window.__played || '')).toMatch(/media\/awake\.mp4$/);
  const v = page.locator('video');
  expect(await v.evaluate(el => [el.muted, el.loop, el.playsInline])).toEqual([true, false, true]);
});

// Alertes écran verrouillé : abonnement push simulé, requêtes vers le serveur enregistrées.
async function fakePush(page) {
  const calls = [];
  await page.route(/functions\/v1\/pomodoro-push/, async r => {
    if (r.request().method() === 'POST') calls.push(JSON.parse(r.request().postData()));
    await r.fulfill({ status: 200, body: '{"ok":true}' });
  });
  await page.addInitScript(() => {
    window.__hidden = false;
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => window.__hidden });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => window.__hidden ? 'hidden' : 'visible' });
    const sub = { toJSON: () => ({ endpoint: 'https://web.push.apple.com/test', keys: { p256dh: 'p', auth: 'a' } }) };
    const reg = { pushManager: { getSubscription: async () => sub }, showNotification: async () => {} };
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { configurable: true, get: () => Promise.resolve(reg) });
  });
  return calls;
}
const setHidden = (page, h) => page.evaluate(h => { window.__hidden = h; document.dispatchEvent(new Event('visibilitychange')); }, h);

test("alertes : nettoyées à l'ouverture, envoyées une seule fois, dans l'ordre", async ({ page }) => {
  const calls = await fakePush(page);
  await open(page, { cfg: { push: true, work: 1, short: 1 } });
  // À l'ouverture : on retire les alertes laissées par une app fermée de force.
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({ action: 'cancel' });
  await toggle(page).click();
  await setHidden(page, true);
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1].action).toBe('schedule');
  expect(calls[1].jobs[0].kind).toBe('work');
  await setHidden(page, false);
  await expect.poll(() => calls.length).toBe(3);
  expect(calls[2].action).toBe('cancel');
  const seqs = calls.map(c => c.seq);
  expect(seqs.every(Number.isSafeInteger)).toBe(true);
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  expect(new Set(seqs).size).toBe(seqs.length);
});
