// ตัวละคร 3D (VRM) ในหน้าแก้ไข agent — feature-vrm.js
// โหลด .vrm ด้วย three.js + @pixiv/three-vrm, เล่นท่า Mixamo (.fbx) ด้วย retarget
// ลง humanoid rig, ตั้ง expression/blendshape ได้ และทดสอบ lipsync ตามจังหวะพิมพ์
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const M = () => window.Mimi;
const el = (tag, cls, text) => M().el(tag, cls, text);
const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);
const markDirty = () => {
  M().ui.agentDirty = true;
};
const api = (path, init = {}) => M().api(path, init);

// ---------- Mixamo -> VRM retarget (port จากตัวอย่าง pixiv/three-vrm) ----------
const MIXAMO_RIG = {
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigLeftHandThumb1: 'leftThumbMetacarpal',
  mixamorigLeftHandThumb2: 'leftThumbProximal',
  mixamorigLeftHandThumb3: 'leftThumbDistal',
  mixamorigLeftHandIndex1: 'leftIndexProximal',
  mixamorigLeftHandIndex2: 'leftIndexIntermediate',
  mixamorigLeftHandIndex3: 'leftIndexDistal',
  mixamorigLeftHandMiddle1: 'leftMiddleProximal',
  mixamorigLeftHandMiddle2: 'leftMiddleIntermediate',
  mixamorigLeftHandMiddle3: 'leftMiddleDistal',
  mixamorigLeftHandRing1: 'leftRingProximal',
  mixamorigLeftHandRing2: 'leftRingIntermediate',
  mixamorigLeftHandRing3: 'leftRingDistal',
  mixamorigLeftHandPinky1: 'leftLittleProximal',
  mixamorigLeftHandPinky2: 'leftLittleIntermediate',
  mixamorigLeftHandPinky3: 'leftLittleDistal',
  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigRightHandPinky1: 'rightLittleProximal',
  mixamorigRightHandPinky2: 'rightLittleIntermediate',
  mixamorigRightHandPinky3: 'rightLittleDistal',
  mixamorigRightHandRing1: 'rightRingProximal',
  mixamorigRightHandRing2: 'rightRingIntermediate',
  mixamorigRightHandRing3: 'rightRingDistal',
  mixamorigRightHandMiddle1: 'rightMiddleProximal',
  mixamorigRightHandMiddle2: 'rightMiddleIntermediate',
  mixamorigRightHandMiddle3: 'rightMiddleDistal',
  mixamorigRightHandIndex1: 'rightIndexProximal',
  mixamorigRightHandIndex2: 'rightIndexIntermediate',
  mixamorigRightHandIndex3: 'rightIndexDistal',
  mixamorigRightHandThumb1: 'rightThumbMetacarpal',
  mixamorigRightHandThumb2: 'rightThumbProximal',
  mixamorigRightHandThumb3: 'rightThumbDistal',
  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes',
};

/** แปลง AnimationClip ของ FBX (skeleton mixamo) ให้เล่นกับ humanoid rig ของ VRM */
function retargetMixamoClip(asset, vrm) {
  const clip = THREE.AnimationClip.findByName(asset.animations, 'mixamo.com') || asset.animations[0];
  if (!clip) throw new Error('ไฟล์ FBX นี้ไม่มี animation');
  const hips = asset.getObjectByName('mixamorigHips');
  const vrmHips = vrm.humanoid.normalizedRestPose.hips.position[1];
  if (!hips) throw new Error('FBX นี้ไม่ใช่ rig ของ Mixamo');
  const hipsScale = vrmHips / hips.position.y;
  const restInverse = new THREE.Quaternion();
  const parentRest = new THREE.Quaternion();
  const quat = new THREE.Quaternion();
  const tracks = [];

  for (const track of clip.tracks) {
    const [rigName, property] = track.name.split('.');
    const boneName = MIXAMO_RIG[rigName];
    const bone = boneName && vrm.humanoid.getNormalizedBoneNode(boneName);
    const rigNode = asset.getObjectByName(rigName);
    if (!bone || !rigNode) continue;

    rigNode.getWorldQuaternion(restInverse).invert();
    rigNode.parent.getWorldQuaternion(parentRest);

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const values = track.values.slice();
      for (let i = 0; i < values.length; i += 4) {
        quat.fromArray(values, i).premultiply(parentRest).multiply(restInverse);
        quat.toArray(values, i);
      }
      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${bone.name}.${property}`,
          track.times,
          vrm.meta.metaVersion === '0' ? values.map((v, i) => (i % 2 === 0 ? -v : v)) : values,
        ),
      );
    } else if (track instanceof THREE.VectorKeyframeTrack) {
      const values = track.values.map(
        (v, i) => (vrm.meta.metaVersion === '0' && i % 3 !== 1 ? -v : v) * hipsScale,
      );
      tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.${property}`, track.times, values));
    }
  }
  if (tracks.length === 0) throw new Error('Retarget ไม่สำเร็จ — ตัวละครนี้ยังไม่ได้ auto-rig แบบ Mixamo');
  return new THREE.AnimationClip('vrm-' + clip.name, clip.duration, tracks);
}

// ---------- ค่าคงที่ expression ----------
const EXPRESSION_PRESETS = [
  ['neutral', 'ปกติ'],
  ['happy', 'มีความสุข'],
  ['sad', 'เศร้า'],
  ['angry', 'โกรธ'],
  ['relaxed', 'ผ่อนคลาย'],
  ['surprised', 'ประหลาดใจ'],
];
const LIP_VOWELS = ['aa', 'ih', 'ou', 'ee', 'oh'];
const RESERVED = new Set([...EXPRESSION_PRESETS.map((entry) => entry[0]), ...LIP_VOWELS, 'blink', 'blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight']);

// ---------- สถานะที่อยู่ข้ามการ re-render ----------
const engine = {
  started: false,
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  clock: null,
  vrm: null,
  mixer: null,
  action: null, // action ของ motion ที่กำลังเล่น
  loading: null, // Promise กันโหลด model ซ้ำซ้อน
  resizeObserver: null,
  agent: null, // ชื่อ agent ที่โหลด model อยู่
  modelVersion: null,
  motions: new Map(), // name -> AnimationClip (retarget แล้ว)
  motionVersions: new Map(),
  playing: null, // ชื่อ motion ที่กำลังเล่น
  loop: true,
  expression: 'neutral',
  blinkTimer: 0,
  blinkUntil: 0,
  speakToken: 0,
};
const formState = { agent: null, mode: 'sprite', idle: '' };
/** select ท่าทางของ panel ล่าสุด (เพื่อ sync ค่าเมื่อกดเล่นจากรายการ) */
let uiMotionSelect = null;
/** container ของ panel ล่าสุด (ไว้ re-render หลังอัปโหลด/ลบไฟล์) */
let uiContainer = null;

// ---------- engine (สร้างครั้งเดียว) ----------
function ensureEngine() {
  if (engine.started) return;
  engine.started = true;
  engine.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  engine.renderer.setPixelRatio(window.devicePixelRatio || 1);
  engine.renderer.domElement.style.width = '100%';
  engine.renderer.domElement.style.height = '100%';
  engine.renderer.domElement.style.display = 'block';
  engine.scene = new THREE.Scene();
  engine.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 20);
  engine.camera.position.set(0, 1.25, 2.6);
  engine.controls = new OrbitControls(engine.camera, engine.renderer.domElement);
  engine.controls.target.set(0, 1.25, 0);
  engine.controls.enableDamping = true;
  engine.controls.dampingFactor = 0.1;
  engine.controls.minDistance = 0.5;
  engine.controls.maxDistance = 8;
  engine.controls.update();
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(1, 1.4, 1).normalize();
  engine.scene.add(light);
  engine.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  engine.clock = new THREE.Timer();

  const tick = () => {
    requestAnimationFrame(tick);
    if (!engine.renderer.domElement.isConnected) return;
    engine.clock.update();
    const delta = Math.min(engine.clock.getDelta(), 0.1);
    if (engine.vrm) {
      // กระพริบตาอัตโนมัติ
      engine.blinkTimer -= delta;
      if (engine.blinkTimer <= 0) {
        engine.blinkTimer = 2 + Math.random() * 3;
        engine.blinkUntil = engine.clock.getElapsed() + 0.12;
        engine.vrm.expressionManager.setValue('blink', 1);
      }
      if (engine.blinkUntil > 0 && engine.clock.getElapsed() > engine.blinkUntil) {
        engine.blinkUntil = 0;
        engine.vrm.expressionManager.setValue('blink', 0);
      }
      engine.vrm.update(delta);
    }
    if (engine.mixer) engine.mixer.update(delta);
    if (engine.controls.enabled) engine.controls.update();
    engine.renderer.render(engine.scene, engine.camera);
  };
  tick();
}

function resizeView(view) {
  const rect = view.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    engine.camera.aspect = rect.width / rect.height;
    engine.camera.updateProjectionMatrix();
    engine.renderer.setSize(rect.width, rect.height, false);
  }
}

// ---------- โหลด model ----------
async function fetchBuffer(path) {
  const response = await api(path);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function loadModel(agent) {
  ensureEngine();
  if (engine.loading) return engine.loading;
  engine.loading = (async () => {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const buffer = await fetchBuffer(`/api/agent-model/${encodeURIComponent(agent.name)}?v=${agent.model}`);
    const gltf = await loader.parseAsync(buffer, '');
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('ไฟล์นี้ไม่ใช่ VRM');
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.combineMorphs(vrm);
    if (vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
    // ให้ตัวละครอยู่ท่า rest ของ rig normalized (autoUpdateHumanBones จะคัดลอกไปที่ raw ทุกเฟรม)
    vrm.humanoid.resetNormalizedPose();
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });

    if (engine.vrm) {
      engine.scene.remove(engine.vrm.scene);
      VRMUtils.deepDispose(engine.vrm.scene);
    }
    engine.vrm = vrm;
    engine.scene.add(vrm.scene);
    engine.mixer = new THREE.AnimationMixer(vrm.scene);
    engine.action = null;
    engine.agent = agent.name;
    engine.modelVersion = agent.model;
    engine.playing = null;
    engine.motions.clear();
    engine.motionVersions.clear();
    setExpression('neutral');
  })().finally(() => {
    engine.loading = null;
  });
  return engine.loading;
}

async function loadMotion(agent, name) {
  ensureEngine();
  if (!engine.vrm) throw new Error('ยังไม่มีโมเดล VRM');
  const view = agent.motions.find((entry) => entry.name === name);
  if (!view) return;
  const buffer = await fetchBuffer(
    `/api/agent-motion/${encodeURIComponent(agent.name)}/${encodeURIComponent(name)}?v=${view.version}`,
  );
  const fbx = await new FBXLoader().parse(buffer, '');
  const clip = retargetMixamoClip(fbx, engine.vrm);
  engine.motions.set(name, clip);
  engine.motionVersions.set(name, view.version);
}

async function syncAssets(agent) {
  // โหลด/ปลด motion ตามรายการล่าสุดของ server
  const current = new Set(agent.motions.map((entry) => entry.name));
  for (const name of [...engine.motions.keys()]) {
    if (!current.has(name)) {
      engine.motions.delete(name);
      engine.motionVersions.delete(name);
      if (engine.playing === name) stopMotion();
    }
  }
  const loads = [];
  for (const view of agent.motions) {
    if (engine.motionVersions.get(view.name) !== view.version) {
      loads.push(
        loadMotion(agent, view.name).catch((error) => {
          console.error(error);
          M().toast(`โหลดท่า "${view.name}" ไม่สำเร็จ`, error.message, true);
        }),
      );
    }
  }
  await Promise.all(loads);
}

// ---------- เล่น motion / expression ----------
function playMotion(name) {
  if (!engine.vrm || !engine.mixer) return;
  if (engine.action) engine.action.fadeOut(0.2);
  engine.mixer.stopAllAction();
  engine.vrm.humanoid.resetNormalizedPose();
  if (!name) {
    engine.playing = null;
    engine.action = null;
    if (uiMotionSelect) uiMotionSelect.value = '';
    return;
  }
  const clip = engine.motions.get(name);
  if (!clip) return;
  const action = engine.mixer.clipAction(clip);
  action.setLoop(engine.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  action.clampWhenFinished = !engine.loop;
  action.reset().fadeIn(0.2).play();
  engine.action = action;
  engine.playing = name;
  if (uiMotionSelect) uiMotionSelect.value = name;
}

function stopMotion() {
  if (!engine.vrm) return;
  engine.playing = null;
  if (engine.action) engine.action.fadeOut(0.2);
  engine.action = null;
  engine.vrm.humanoid.resetNormalizedPose();
  if (uiMotionSelect) uiMotionSelect.value = '';
}

function setExpression(name) {
  if (!engine.vrm) return;
  const manager = engine.vrm.expressionManager;
  for (const [preset] of EXPRESSION_PRESETS) manager.setValue(preset, preset === name ? 1 : 0);
  engine.expression = name;
}

/** ขยับปากตามจังหวะตัวอักษร (lipsync แบบสุ่ม/พิมพ์) */
function speak(text, onDone) {
  if (!engine.vrm) return;
  engine.speakToken++;
  const token = engine.speakToken;
  const manager = engine.vrm.expressionManager;
  const chars = text.replace(/\s+/g, ' ').trim();
  let index = 0;
  const step = () => {
    if (token !== engine.speakToken) return;
    const char = chars[index] || '';
    index++;
    const vowels = LIP_VOWELS.filter((vowel) => manager.getExpression(vowel));
    if (vowels.length === 0) return;
    const isVowelish = /[aeiouะาิีึืุูเแโใไอำ]/.test(char.toLowerCase());
    const picked = isVowelish || Math.random() < 0.75 ? vowels[Math.floor(Math.random() * vowels.length)] : null;
    for (const vowel of vowels) manager.setValue(vowel, vowel === picked ? 0.9 : 0.1);
    if (index < chars.length) {
      setTimeout(step, 60 + Math.random() * 90);
    } else {
      setTimeout(() => {
        for (const vowel of vowels) manager.setValue(vowel, 0);
        onDone && onDone();
      }, 200);
    }
  };
  step();
}

// ---------- ปุ่ม/ฟอร์ม ----------
function radio(value, label, current, onPick) {
  const node = el('label', 'char-mode');
  const input = el('input');
  input.type = 'radio';
  input.name = 'char-mode';
  input.value = value;
  input.checked = value === current;
  input.onchange = () => {
    if (input.checked) onPick(value);
  };
  node.append(input, el('span', '', label));
  return node;
}

function filePicker(accept, onFile) {
  const input = el('input');
  input.type = 'file';
  input.accept = accept;
  input.hidden = true;
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (file) onFile(file);
    input.value = '';
  };
  return input;
}

// ---------- หน้า panel ----------
function render(container, agent) {
  container.replaceChildren();
  uiContainer = container;
  if (formState.agent !== agent.name) {
    formState.agent = agent.name;
    formState.mode = agent.character === 'vrm' ? 'vrm' : 'sprite';
    formState.idle = agent.idleMotion || '';
  }

  const hint = el('p', 'hint');
  hint.textContent =
    'Sprite = รูปนิ่ง (avatar/portrait ด้านบน) · VRM = โมเดล 3D จาก VRoid พร้อมท่าทาง (Mixamo), expression, blendshape และ lipsync';
  container.append(hint);

  const modes = el('div', 'char-modes');
  modes.append(
    radio('sprite', 'รูป (sprite)', formState.mode, (value) => {
      formState.mode = value;
      markDirty();
      render(container, agent);
    }),
    radio('vrm', 'โมเดล 3D (VRM)', formState.mode, (value) => {
      formState.mode = value;
      markDirty();
      render(container, agent);
    }),
  );
  container.append(modes);

  if (formState.mode === 'sprite') {
    container.append(el('p', 'hint', 'ใช้รูป avatar (โปรไฟล์) และ portrait (พื้นหลังแชต) ที่ตั้งไว้ด้านบน'));
    return;
  }
  renderVrm(container, agent);
}

function renderVrm(container, agent) {
  ensureEngine();

  // --- ไฟล์โมเดล ---
  const modelRow = el('div', 'char-row');
  const modelLabel = el('span', 'char-model-label');
  modelLabel.textContent = agent.model ? `model.vrm (รุ่น ${new Date(Number(agent.model)).toLocaleString('th-TH')})` : 'ยังไม่มีโมเดล VRM';
  modelRow.append(modelLabel);
  const pick = filePicker('.vrm', (file) => uploadModel(agent, file));
  modelRow.append(button('btn', agent.model ? 'เปลี่ยนไฟล์ .vrm' : 'อัปโหลด .vrm', () => pick.click()));
  if (agent.model) {
    modelRow.append(
      button('btn ghost', 'ลบ', async () => {
        const response = await api(`/api/agent-model/${encodeURIComponent(agent.name)}`, { method: 'DELETE' });
        if (!response.ok) return M().toast('ลบไม่สำเร็จ', null, true);
        agent.model = null;
        resetModel();
        if (uiContainer && uiContainer.isConnected) render(uiContainer, agent);
      }),
    );
  }
  container.append(el('p', 'hint', 'โมเดลจาก VRoid Studio (VRM 0.x/1.0) — ต้องตั้งท่า T-pose แล้ว export จึงจะ retarget กับ Mixamo ได้'), modelRow, pick);

  // --- ฉาก 3D ---
  const view = el('div', 'char-view');
  container.append(view);
  view.append(engine.renderer.domElement);
  if (engine.resizeObserver) engine.resizeObserver.disconnect();
  engine.resizeObserver = new ResizeObserver(() => resizeView(view));
  engine.resizeObserver.observe(view);
  resizeView(view);

  const controlsRow = el('div', 'char-row');
  const motionSelect = el('select');
  motionSelect.append(new Option('— หยุด (ท่า rest) —', ''));
  for (const motion of agent.motions) motionSelect.append(new Option(motion.name, motion.name));
  motionSelect.value = engine.playing || '';
  motionSelect.onchange = () => {
    playMotion(motionSelect.value || null);
  };
  uiMotionSelect = motionSelect;
  const loop = el('label', 'check');
  const loopInput = el('input');
  loopInput.type = 'checkbox';
  loopInput.checked = engine.loop;
  loopInput.onchange = () => {
    engine.loop = loopInput.checked;
    if (engine.playing) playMotion(engine.playing);
  };
  loop.append(loopInput, el('span', '', 'วนซ้ำ'));
  controlsRow.append(el('span', '', 'ท่าทาง (Mixamo)'), motionSelect, loop);
  controlsRow.append(
    button('btn ghost', 'ท่า rest', () => {
      stopMotion();
      motionSelect.value = '';
    }),
    button('btn ghost', 'กล้อง', () => {
      engine.camera.position.set(0, 1.25, 2.6);
      engine.controls.target.set(0, 1.25, 0);
      engine.controls.update();
    }),
  );
  container.append(controlsRow);

  const idleRow = el('div', 'char-row');
  const idleSelect = el('select');
  idleSelect.append(new Option('— ยืนนิ่ง —', ''));
  for (const motion of agent.motions) idleSelect.append(new Option(motion.name, motion.name));
  idleSelect.value = formState.idle;
  idleSelect.onchange = () => {
    formState.idle = idleSelect.value;
    markDirty();
  };
  idleRow.append(el('span', '', 'ท่าประจำ (idle)'), idleSelect);
  idleRow.append(el('small', 'faint', 'ท่าแสดงตามค่าเริ่มต้นของตัวละคร — บันทึก agent ด้วย'));
  container.append(idleRow);

  // --- expression ---
  const expressionRow = el('div', 'char-row');
  expressionRow.append(el('span', '', 'อารมณ์'));
  const presets = EXPRESSION_PRESETS.filter(
    ([name]) => engine.vrm && engine.vrm.expressionManager.getExpression(name),
  );
  for (const [name, label] of presets) {
    expressionRow.append(
      button(`chip${engine.expression === name ? ' on' : ''}`, label, (event) => {
        setExpression(name);
        [...expressionRow.querySelectorAll('.chip')].forEach((chip) => chip.classList.remove('on'));
        event.currentTarget.classList.add('on');
      }),
    );
  }
  if (!engine.vrm) expressionRow.append(el('small', 'faint', ' (อัปโหลดโมเดลก่อน)'));
  container.append(expressionRow);

  // --- lipsync ---
  const lipRow = el('div', 'char-row');
  const lipInput = el('input', 'inp');
  lipInput.placeholder = 'พิมพ์ข้อความ แล้วกดทดสอบพูด (ขยับปากตามจังหวะพิมพ์)';
  lipRow.append(lipInput);
  const lipButton = button('btn', 'ทดสอบพูด', () => {
    const text = lipInput.value.trim();
    if (!text) return;
    lipButton.disabled = true;
    speak(text, () => {
      lipButton.disabled = false;
    });
  });
  lipRow.append(lipButton);
  container.append(lipRow);

  // --- blendshape ของโมเดล ---
  if (engine.vrm) {
    const custom = engine.vrm.expressionManager.expressions
      .map((entry) => entry.expressionName)
      .filter((name) => !RESERVED.has(name));
    if (custom.length > 0) {
      const details = el('details', 'char-blend');
      const summary = el('summary', '', `Blendshape ของโมเดลนี้ (${custom.length}) — rig`);
      details.append(summary);
      const grid = el('div', 'char-blend-grid');
      for (const name of custom) {
        const label = el('label', 'char-slider');
        const input = el('input');
        input.type = 'range';
        input.min = 0;
        input.max = 1;
        input.step = 0.01;
        input.value = 0;
        input.oninput = () => {
          if (engine.vrm) engine.vrm.expressionManager.setValue(name, Number(input.value));
        };
        label.append(el('span', '', name), input);
        grid.append(label);
      }
      details.append(grid);
      container.append(details);
    }
  }

  // --- รายการ motion + อัปโหลด ---
  container.append(el('h4', '', `ท่าทางจาก Mixamo (${agent.motions.length})`));
  container.append(
    el(
      'p',
      'hint',
      'วิธีทำ: เข้า mixamo.com → อัปโหลดตัวละคร (ไฟล์ .vrm ที่ export แบบ T-pose) → Auto-Rigger → เลือก animation → Download (FBX, without skin) → อัปโหลดที่นี่',
    ),
  );
  const list = el('div', 'list');
  if (agent.motions.length === 0) {
    list.append(el('div', 'empty', 'ยังไม่มีท่าทาง — อัปโหลดไฟล์ .fbx จาก Mixamo'));
  }
  for (const motion of agent.motions) {
    const row = el('div', 'item char-motion');
    row.onclick = () => {
      playMotion(motion.name);
      if (uiMotionSelect) uiMotionSelect.value = motion.name;
    };
    const info = el('div');
    info.append(el('b', '', motion.name));
    if (engine.motionVersions.get(motion.name) !== motion.version) {
      info.append(el('small', 'faint', 'กำลังโหลด…'));
    } else if (engine.playing === motion.name) {
      info.append(el('small', 'faint', 'กำลังเล่น'));
    }
    row.append(info);
    row.append(
      button('btn ghost', 'ลบ', async (event) => {
        event.stopPropagation();
        const response = await api(
          `/api/agent-motion/${encodeURIComponent(agent.name)}/${encodeURIComponent(motion.name)}`,
          { method: 'DELETE' },
        );
        if (!response.ok) return M().toast('ลบไม่สำเร็จ', null, true);
        engine.motions.delete(motion.name);
        engine.motionVersions.delete(motion.name);
        agent.motions = agent.motions.filter((entry) => entry.name !== motion.name);
        if (engine.playing === motion.name) stopMotion();
        if (uiContainer && uiContainer.isConnected) render(uiContainer, agent);
      }),
    );
    list.append(row);
  }
  const upload = filePicker('.fbx', (file) => uploadMotion(agent, file));
  list.append(button('btn', '+ อัปโหลดท่า (.fbx)', () => upload.click()), upload);
  container.append(list);

  if (!agent.model) {
    if (engine.agent !== null) resetModel();
  } else if (engine.agent !== agent.name || engine.modelVersion !== agent.model) {
    loadModel(agent)
      .then(async () => {
        await syncAssets(agent);
        if (formState.idle) playMotion(formState.idle);
        if (uiContainer && uiContainer.isConnected && formState.agent === agent.name && formState.mode === 'vrm') render(uiContainer, agent);
      })
      .catch((error) => M().toast('โหลดโมเดล VRM ไม่สำเร็จ', error.message, true));
  } else {
    void syncAssets(agent);
  }
}

/** อัปเดตรายการ motion จาก server แล้วโหลดโมเดล/motion ใหม่ทันที (หลังอัปโหลด) */
async function forceReload(agent) {
  const listResponse = await api(`/api/agent-motions/${encodeURIComponent(agent.name)}`);
  if (listResponse.ok) agent.motions = (await listResponse.json()).motions;
  agent.model = String(Date.now()); // บังคับ fetch ใหม่ทั้งที่ยังไม่ได้รับ version จาก broadcast
  engine.modelVersion = null;
  try {
    await loadModel(agent);
    await syncAssets(agent);
    if (formState.idle) playMotion(formState.idle);
  } catch (error) {
    M().toast('โหลดโมเดล VRM ไม่สำเร็จ', error.message, true);
  }
  // ปัด panel ใหม่ให้เห็นโมเดล/ท่าล่าสุด (agent-save ยังไม่ได้ส่ง broadcast เมื่อ form มีการแก้ไขค้าง)
  if (uiContainer && uiContainer.isConnected && formState.agent === agent.name && formState.mode === 'vrm') {
    render(uiContainer, agent);
  }
}

function resetModel() {
  if (engine.vrm) {
    engine.scene.remove(engine.vrm.scene);
    VRMUtils.deepDispose(engine.vrm.scene);
  }
  engine.vrm = null;
  engine.mixer = null;
  engine.action = null;
  engine.agent = null;
  engine.modelVersion = null;
  engine.playing = null;
  engine.motions.clear();
  engine.motionVersions.clear();
}

async function uploadModel(agent, file) {
  const response = await api(`/api/agent-model/${encodeURIComponent(agent.name)}`, {
    method: 'POST',
    headers: { 'content-type': 'model/vrm' },
    body: file,
  });
  if (!response.ok) return M().toast('อัปโหลดไม่สำเร็จ', (await response.json()).error, true);
  M().toast('อัปโหลดโมเดลแล้ว', 'กำลังโหลดเข้าฉาก 3D…');
  await forceReload(agent);
}

async function uploadMotion(agent, file) {
  const name = file.name.replace(/\.fbx$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) return M().toast('ชื่อไฟล์ไม่ถูกต้อง', 'ใช้ชื่อ a-z 0-9 - _', true);
  const response = await api(`/api/agent-motion/${encodeURIComponent(agent.name)}/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  if (!response.ok) return M().toast('อัปโหลดไม่สำเร็จ', (await response.json()).error, true);
  M().toast('อัปโหลดท่าทางแล้ว', 'กำลังโหลดเข้า preview…');
  await forceReload(agent);
}

// ---------- ค่าที่เอาไปรวมกับ agent-save ----------
function form() {
  return { character: formState.mode, idleMotion: formState.idle || null };
}

window.MimiHooks = window.MimiHooks || {};
window.MimiHooks.character = { render, form };

// ---------- the chat stage: the agent as a live 3D model (instead of a picture) ----------
// feature-stage.js decides when (direct chat, agent shown as VRM) and which file (the
// outfit's model or the agent's own); this draws it: a relaxed standing pose, breathing,
// blinking, eyes on the viewer, the mood of the last emoji, and the mouth moving while a
// reply streams in. Spring bones (hair, clothes) move by themselves.

/** Emoji (code points in hex, as feature-stage.js keys them) -> expression preset. */
const EMOJI_MOOD = {};
for (const [preset, keys] of Object.entries({
  happy: '1f60a 1f604 1f601 1f603 1f600 1f970 1f60d 263a 1f642 1f606 1f917 1f60b 1f61d 1f61c 2764 1f495 1f496 1f973 1f44b 1f60e 1f929 2728 1f389 1f338',
  angry: '1f620 1f621 1f624 1f4a2 1f92c 1f47f 1f612 1f644',
  sad: '1f622 1f62d 1f61e 1f614 1f97a 1f63f 1f625 1f613 1f494 1f61f 1f629',
  relaxed: '1f60c 1f634 1f607 1f60f 1f375 1f64f 1f917',
  surprised: '1f632 1f62e 1f631 1f92f 1f633 2757 203c 1f62f 1f640 2049',
})) {
  for (const key of keys.split(' ')) EMOJI_MOOD[key] = preset;
}
const MOOD_WEIGHT = { happy: 0.75, angry: 0.7, sad: 0.75, relaxed: 0.7, surprised: 0.65, neutral: 0 };

const live = {
  /** Where the user put the camera: yaw / pitch in degrees, zoom as a factor, x / y as % of the figure's height. */
  view: { yaw: 0, pitch: 0, zoom: 1, x: 0, y: 0 },
  renderer: null,
  scene: null,
  camera: null,
  clock: null,
  observer: null,
  wrap: null,
  vrm: null,
  path: '',
  loading: '',
  mood: 'neutral',
  talkUntil: 0,
  blinkTimer: 2,
  blinkUntil: 0,
};

function liveStart() {
  if (live.renderer) return;
  live.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  live.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  live.renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = live.renderer.domElement;
  canvas.className = 'vrm-live';
  live.scene = new THREE.Scene();
  live.camera = new THREE.PerspectiveCamera(24, 1, 0.05, 30);
  const light = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
  light.position.set(0.6, 1.6, 1.4).normalize();
  live.scene.add(light, new THREE.AmbientLight(0xffffff, 0.75));
  live.clock = new THREE.Timer();
  live.observer = new ResizeObserver(() => liveResize());

  let lastDraw = 0;
  const tick = (now = performance.now()) => {
    requestAnimationFrame(tick);
    if (!canvas.isConnected || document.hidden || !live.vrm) return;
    // While a text field has the keyboard the character redraws at ~15 fps: typing (and
    // holding Backspace) stays smooth on a phone, which cannot do both at full rate.
    const field = document.activeElement;
    const typing = field && (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT');
    if (typing && now - (window.__mimiKeyAt || 0) < 350) return; // a key just went in: leave the frame to the keyboard
    if (typing && now - lastDraw < 66) return;
    lastDraw = now;
    live.clock.update();
    const delta = Math.min(live.clock.getDelta(), 0.1);
    const t = live.clock.getElapsed();
    liveIdle(t);
    liveFace(delta, t);
    live.vrm.update(delta);
    live.renderer.render(live.scene, live.camera);
  };
  tick();
}

function liveResize() {
  const wrap = live.wrap;
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  live.camera.aspect = rect.width / rect.height;
  live.camera.updateProjectionMatrix();
  live.renderer.setSize(rect.width, rect.height, false);
  liveFrame();
}

/** Whole figure in view, feet at the bottom of the stage. */
function liveFrame() {
  if (!live.vrm) return;
  const box = new THREE.Box3().setFromObject(live.vrm.scene);
  const height = Math.max(box.max.y - box.min.y, 0.5);
  const fov = THREE.MathUtils.degToRad(live.camera.fov);
  const fitHeight = height * 1.06;
  let distance = fitHeight / 2 / Math.tan(fov / 2);
  // A narrow stage must also fit the arms' width.
  const width = Math.max(box.max.x - box.min.x, 0.4) * 1.1;
  const fitWidth = width / 2 / (Math.tan(fov / 2) * live.camera.aspect);
  distance = Math.max(distance, fitWidth);
  const middle = box.min.y + height * 0.5;
  // Orbit around the middle of the figure, then slide camera and target together (x / y: where the figure goes on screen).
  const { yaw, pitch, zoom, x, y } = live.view;
  const radius = distance / Math.max(zoom, 0.1);
  const turn = THREE.MathUtils.degToRad(yaw);
  const tilt = THREE.MathUtils.degToRad(pitch);
  const target = new THREE.Vector3(0, middle, 0);
  live.camera.position.set(
    Math.sin(turn) * Math.cos(tilt) * radius,
    middle + Math.sin(tilt) * radius,
    Math.cos(turn) * Math.cos(tilt) * radius,
  );
  live.camera.lookAt(target);
  live.camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(live.camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(live.camera.matrixWorld, 1);
  const shift = right.multiplyScalar((-x / 100) * height).add(up.multiplyScalar((-y / 100) * height));
  live.camera.position.add(shift);
  target.add(shift);
  live.camera.lookAt(target);
}

/** The chat stage's camera, as set in Chat setting. */
function liveSetView(view) {
  live.view = { yaw: 0, pitch: 0, zoom: 1, x: 0, y: 0, ...view };
  liveFrame();
}

/** A relaxed standing pose with breathing; the rest pose of a VRM is a T-pose. */
function liveIdle(t) {
  const humanoid = live.vrm.humanoid;
  const bone = (name) => humanoid.getNormalizedBoneNode(name);
  const set = (name, x, y, z) => {
    const node = bone(name);
    if (node) node.rotation.set(x, y, z);
  };
  const breath = Math.sin(t * 1.7);
  set('leftUpperArm', 0.05, 0, -1.22 - breath * 0.015);
  set('rightUpperArm', 0.05, 0, 1.22 + breath * 0.015);
  set('leftLowerArm', 0, -0.25, -0.12);
  set('rightLowerArm', 0, 0.25, 0.12);
  set('leftHand', 0, 0, -0.1);
  set('rightHand', 0, 0, 0.1);
  set('spine', breath * 0.012, 0, 0);
  set('chest', breath * 0.018, 0, 0);
  set('neck', 0, Math.sin(t * 0.45) * 0.04, 0);
  set('head', Math.sin(t * 0.7) * 0.025, Math.sin(t * 0.37) * 0.07, Math.sin(t * 0.53) * 0.02);
  set('hips', 0, Math.sin(t * 0.3) * 0.02, 0);
}

/** Blinks, the mood of the last emoji (eased in), and the mouth while talking. */
function liveFace(delta, t) {
  const manager = live.vrm.expressionManager;
  if (!manager) return;
  live.blinkTimer -= delta;
  if (live.blinkTimer <= 0) {
    live.blinkTimer = 2.2 + Math.random() * 3.5;
    live.blinkUntil = t + 0.13;
  }
  const blinking = t < live.blinkUntil;
  const ease = Math.min(1, delta * 6);
  for (const preset of ['happy', 'angry', 'sad', 'relaxed', 'surprised']) {
    if (!manager.getExpression(preset)) continue;
    const target = live.mood === preset ? MOOD_WEIGHT[preset] : 0;
    const now = manager.getValue(preset) || 0;
    manager.setValue(preset, now + (target - now) * ease);
  }
  // happy/relaxed close the eyes on their own; a blink on top would look odd
  manager.setValue('blink', blinking && live.mood !== 'happy' && live.mood !== 'relaxed' ? 1 : 0);
  const talking = performance.now() < live.talkUntil;
  const mouth = talking ? 0.15 + 0.55 * Math.abs(Math.sin(t * 15)) : 0;
  const was = manager.getValue('aa') || 0;
  if (manager.getExpression('aa')) manager.setValue('aa', was + (mouth - was) * Math.min(1, delta * 18));
}

async function liveLoad(path) {
  live.loading = path;
  const response = await api(path);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (live.loading !== path) return; // another model was asked for meanwhile
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(buffer, '');
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('ไฟล์นี้ไม่ใช่ VRM');
  if (live.loading !== path) {
    VRMUtils.deepDispose(gltf.scene);
    return;
  }
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.combineMorphs(vrm);
  if (vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
  vrm.humanoid.resetNormalizedPose();
  vrm.scene.traverse((object) => {
    object.frustumCulled = false;
  });
  if (vrm.lookAt) vrm.lookAt.target = live.camera;
  const canvas = live.renderer.domElement;
  const old = live.vrm;
  // A change of outfit: fade out, swap, fade in.
  if (old) {
    canvas.classList.add('swap');
    await new Promise((resolve) => setTimeout(resolve, 260));
    live.scene.remove(old.scene);
    VRMUtils.deepDispose(old.scene);
  }
  live.vrm = vrm;
  live.path = path;
  live.loading = '';
  live.scene.add(vrm.scene);
  liveIdle(0);
  vrm.update(0);
  liveFrame();
  canvas.classList.remove('swap');
}

/** Shows the model at `path` in `wrap` (the stage's figure layer) with the mood of `moodKey`. */
function liveShow(wrap, path, moodKey) {
  liveStart();
  const canvas = live.renderer.domElement;
  if (canvas.parentElement !== wrap) {
    wrap.append(canvas);
    live.observer.disconnect();
    live.observer.observe(wrap);
  }
  live.wrap = wrap;
  liveResize();
  live.mood = (moodKey && EMOJI_MOOD[moodKey]) || 'neutral';
  if (path === live.path || path === live.loading) return;
  liveLoad(path).catch((error) => {
    live.loading = '';
    console.error(error);
    M().toast('โหลดโมเดล VRM บนหน้าแชตไม่สำเร็จ', error.message, true);
  });
}

function liveHide() {
  if (!live.renderer) return;
  live.loading = '';
  if (live.vrm) {
    live.scene.remove(live.vrm.scene);
    VRMUtils.deepDispose(live.vrm.scene);
    live.vrm = null;
  }
  live.path = '';
  live.renderer.domElement.remove();
  live.observer.disconnect();
  live.wrap = null;
}

/** The mouth moves for a moment; called for every piece of a reply that streams in. */
function liveTalk() {
  live.talkUntil = performance.now() + 450;
}

window.MimiHooks.vrmStage = { show: liveShow, hide: liveHide, talk: liveTalk, setView: liveSetView };
