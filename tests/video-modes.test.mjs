import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
assert.ok(scripts.length > 0, "HTML contains inline scripts");
for (const [, script] of scripts) new Function(script);

const start = html.indexOf("/* BEGIN VIDEO MODE LOGIC */");
const end = html.indexOf("/* END VIDEO MODE LOGIC */");
assert.ok(start >= 0 && end > start, "mode storyboard logic is marked for isolated tests");
const code = html.slice(start, end + "/* END VIDEO MODE LOGIC */".length);
const selectedCameras = ["Dolly In", "Product Reveal", "Hero Product Shot", "Orbit Shot"];
const api = vm.runInNewContext(
  `${code}\n({productScenePlan,scenePlan,buildScenePrompt,buildMasterPrompt,buildAIStoryboardPrompt})`,
  { selectedCameras }
);

const modeSelect = html.match(/<select id="videoMode" hidden[^>]*>([\s\S]*?)<\/select>/)?.[1] || "";
assert.match(modeSelect, /<option value="product">Promosi produk<\/option>\s*<option value="general">Video umum<\/option>/);
const modeChoices = [...html.matchAll(/<input type="radio" name="videoModeChoice" id="([^"]+)" value="([^"]+)"( checked)?/g)];
assert.deepEqual(modeChoices.map(([, id, value, checked]) => [id, value, checked === " checked"]), [["modeProduct", "product", true], ["modeGeneral", "general", false]]);
assert.match(html, /<fieldset class="mode-fieldset"><legend>Jenis video/);
assert.match(html, /\.mode-fieldset\{border:0/);
assert.match(html, /Buat storyboard · lokal/);
assert.match(html, /Buat storyboard · AI Cloud/);
assert.match(html, /Lokal tanpa login\/kredit · AI Cloud perlu login\/kredit/);
assert.doesNotMatch(html, /Creative brief|videoModeHint/);
assert.match(html, /productTemplateControls"\)\.hidden=!isProduct/);
assert.match(html, /productTemplateNote"\)\.hidden=isProduct/);
assert.match(html, /const PROJECT_VALUE_FIELDS = \["videoMode"/);
assert.match(html, /const ids=\["videoMode","productName"/);
assert.match(html, /\$\("videoMode"\)\.value=safeProject\.values\.videoMode==="general"\?"general":"product"/);

const productPlan = api.scenePlan(20, "product", "Makanan dan minuman");
assert.equal(productPlan.map((scene) => scene.name).join("|"), "The Hook|Product Reveal|Texture Showcase|Lifestyle / Benefit|Hero Shot & CTA");
assert.equal(api.productScenePlan(20).map((scene) => scene.name).join("|"), productPlan.map((scene) => scene.name).join("|"));

function durationOf(plan) {
  let cursor = 0;
  for (const scene of plan) {
    const match = scene.t.match(/^(\d+)–(\d+)s$/);
    assert.ok(match, `has readable scene timing: ${scene.t}`);
    const startAt = Number(match[1]), endAt = Number(match[2]);
    assert.equal(startAt, cursor, "scene timings are contiguous");
    assert.ok(endAt > startAt, "each scene has positive duration");
    cursor = endAt;
  }
  return cursor;
}

for (const duration of [10, 20, 30]) {
  const plan = api.scenePlan(duration, "general", "Tutorial & edukasi");
  assert.equal(durationOf(plan), duration, `general ${duration}s plan totals the selected duration`);
  assert.ok(plan.every((scene) => !/product|brand|cta|iklan/i.test(scene.name)), "general scene names are not ad-oriented");
}

const tutorial = api.scenePlan(20, "general", "Tutorial & edukasi");
const vlog = api.scenePlan(20, "general", "Vlog & keseharian");
assert.notEqual(tutorial.map((scene) => scene.name).join("|"), vlog.map((scene) => scene.name).join("|"), "video category changes the story arc");
assert.ok(tutorial.some((scene) => scene.name === "Demonstrasi"), "20-second tutorials include a demonstration");
assert.ok(api.scenePlan(20, "general", "Hiburan & kreatif").some((scene) => scene.name === "Twist atau payoff"), "20-second creative videos include a payoff");

const generalData = {
  videoMode: "general",
  product: "Cara menyeduh kopi dengan V60",
  category: "Tutorial & edukasi",
  description: "Panduan dasar untuk pemula",
  usp: "Perhatikan rasio air dan kopi",
  cta: "Coba langkah ini di rumah",
  duration: 20,
  platform: "YouTube — horizontal 16:9",
  language: "English",
  style: "Documentary realism",
  mood: "Warm, friendly, authentic",
  lighting: "Natural window light",
  voice: "Tanpa voice-over",
  music: "Minimal ambient and subtle sound effects",
  extra: "Gunakan sudut pandang orang pertama"
};
const generalPrompt = api.buildScenePrompt(generalData, tutorial[0], 0, tutorial.length);
assert.match(generalPrompt, /GENERAL VIDEO — NON-PROMOTIONAL/);
assert.match(generalPrompt, /Topic: Cara menyeduh kopi dengan V60/);
assert.match(generalPrompt, /Key idea or learning point: Perhatikan rasio air dan kopi/);
assert.match(generalPrompt, /Creator-specified closing: Coba langkah ini di rumah/);
assert.doesNotMatch(generalPrompt, /Product identity lock:/i);
assert.doesNotMatch(generalPrompt, /Hero Shot & CTA/i);
const cameraLine = generalPrompt.split("\n").find((line) => line.startsWith("Camera:"));
assert.ok(cameraLine && !cameraLine.includes("Product Reveal") && !cameraLine.includes("Hero Product Shot"), "product-only camera choices are omitted from general prompts");

const noClosingPrompt = api.buildScenePrompt({ ...generalData, cta: "" }, tutorial[0], 0, tutorial.length);
assert.match(noClosingPrompt, /do not add a sales call to action/i);
const master = api.buildMasterPrompt(generalData, tutorial);
assert.match(master, /MODE: VIDEO UMUM \(NON-PROMOSI\)/);
assert.doesNotMatch(master, /PRODUCT CONSISTENCY LOCK/);
assert.match(master, /Aplikasi ini tidak merender file video/);
const cloudPrompt = api.buildAIStoryboardPrompt(generalData);
assert.match(cloudPrompt, /video umum yang non-promosi/);
assert.match(cloudPrompt, /bukan iklan/);
assert.match(cloudPrompt, /Output berupa storyboard teks, bukan file video/);
assert.doesNotMatch(cloudPrompt, /Susun storyboard iklan komersial/);

const productData = {
  ...generalData,
  videoMode: "product",
  product: "Bawang Hitam Premium",
  category: "Makanan dan minuman",
  cta: "Pesan sekarang"
};
const productPrompt = api.buildScenePrompt(productData, productPlan[0], 0, productPlan.length);
assert.match(productPrompt, /Product identity lock: Bawang Hitam Premium/);
assert.match(api.buildMasterPrompt(productData, productPlan), /PRODUCT CONSISTENCY LOCK/);
assert.match(api.buildAIStoryboardPrompt(productData), /storyboard iklan komersial cinematic/);

console.log("video-modes.test.mjs: all assertions passed (no provider or network calls)");
