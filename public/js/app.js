import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, onSnapshot, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCYndV2aTf1KEB6yBgjjhOoUIqUKf3jsJY",
  authDomain: "taikoo-dismissal-system.firebaseapp.com",
  projectId: "taikoo-dismissal-system",
  storageBucket: "taikoo-dismissal-system.firebasestorage.app",
  messagingSenderId: "881254467284",
  appId: "1:881254467284:web:b56a348000ce78a0fc5d41",
  measurementId: "G-64B89N4NQJ"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const ALL_CLASSES = [
  "1A", "1B", "1C", "1D", "1E",
  "2A", "2B", "2C", "2D", "2E",
  "3A", "3B", "3C", "3D", "3E",
  "4A", "4B", "4C", "4D", "4E",
  "5A", "5B", "5C", "5D", "5E",
  "6A", "6B", "6C", "6D", "6E"
];

const DISMISSAL_DOC_REF = doc(db, "dismissal_system", "live_status");
const THREE_MINUTES_MS = 3 * 60 * 1000;

let currentFirestoreData = {};

function getGradeClass(className) {
  return `p${className.charAt(0)}`;
}

function showLoading(show) {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.style.display = show ? 'flex' : 'none';
}

function initLiveClock() {
  const clockEl = document.getElementById('liveClock');
  if (!clockEl) return;

  function updateClock() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    clockEl.textContent = `${hours}:${minutes}:${seconds}`;
  }

  updateClock();
  setInterval(updateClock, 1000);
}

initLiveClock();

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnShowDisplay')?.addEventListener('click', () => switchView('display'));
  document.getElementById('btnShowControl')?.addEventListener('click', () => switchView('control'));
  document.getElementById('btnResetAll')?.addEventListener('click', resetAllClasses);

  setInterval(checkAndExpireClasses, 1000);
});

function switchView(viewName) {
  const displayView = document.getElementById('displayView');
  const controlView = document.getElementById('controlView');
  const btnShowDisplay = document.getElementById('btnShowDisplay');
  const btnShowControl = document.getElementById('btnShowControl');

  displayView.classList.remove('active');
  controlView.classList.remove('active');
  btnShowDisplay.classList.remove('active');
  btnShowControl.classList.remove('active');

  if (viewName === 'display') {
    displayView.classList.add('active');
    btnShowDisplay.classList.add('active');
  } else {
    controlView.classList.add('active');
    btnShowControl.classList.add('active');
  }
}

function checkAndExpireClasses() {
  if (!currentFirestoreData) return;
  const now = Date.now();
  let needUpdateDb = false;

  ALL_CLASSES.forEach(cls => {
    const clsInfo = currentFirestoreData[cls];
    if (clsInfo && clsInfo.status === 'active') {
      if (now - clsInfo.timestamp >= THREE_MINUTES_MS) {
        clsInfo.status = 'done';
        needUpdateDb = true;
      }
    }
  });

  if (needUpdateDb) {
    updateDoc(DISMISSAL_DOC_REF, currentFirestoreData);
    renderDisplayView(currentFirestoreData);
    renderControlView(currentFirestoreData);
  }
}

function initRealtimeListener() {
  onSnapshot(DISMISSAL_DOC_REF, (docSnap) => {
    showLoading(false);
    currentFirestoreData = docSnap.exists() ? docSnap.data() : {};
    
    checkAndExpireClasses();

    renderDisplayView(currentFirestoreData);
    renderControlView(currentFirestoreData);
  }, (error) => {
    showLoading(false);
    if (typeof Swal !== 'undefined') {
      Swal.fire({ icon: 'error', title: '連線錯誤', text: error.message });
    }
  });
}

function renderDisplayView(data) {
  const activeWrapper = document.getElementById('activeClassesWrapper');
  const gridContainer = document.getElementById('displayClassGrid');

  const activeClasses = [];
  gridContainer.innerHTML = '';

  ALL_CLASSES.forEach(cls => {
    const clsInfo = data[cls] || { status: 'waiting' };
    if (clsInfo.status === 'active') {
      activeClasses.push(cls);
    }

    const item = document.createElement('div');
    const gradeClass = getGradeClass(cls);
    item.className = `status-box ${gradeClass} status-${clsInfo.status}`;
    item.textContent = cls;
    gridContainer.appendChild(item);
  });

  if (activeClasses.length === 0) {
    activeWrapper.innerHTML = `<span class="placeholder-text">現時沒有班別放學中</span>`;
  } else if (activeClasses.length <= 5) {
    const badgesHTML = activeClasses.map(cls => {
      const gradeClass = getGradeClass(cls);
      return `<span class="badge-item ${gradeClass}">${cls}</span>`;
    }).join('');

    activeWrapper.innerHTML = `<div class="static-badge-container">${badgesHTML}</div>`;
  } else {
    // 多於 5 班：觸發從右到左完全滑出動畫
    const badgesHTML = activeClasses.map(cls => {
      const gradeClass = getGradeClass(cls);
      return `<span class="badge-item ${gradeClass}">${cls}</span>`;
    }).join('');

    activeWrapper.innerHTML = `
      <div class="marquee-track-slideout">
        ${badgesHTML}
      </div>
    `;
  }
}

function renderControlView(data) {
  const gridContainer = document.getElementById('controlClassGrid');
  gridContainer.innerHTML = '';

  ALL_CLASSES.forEach(cls => {
    const clsInfo = data[cls] || { status: 'waiting' };
    const btn = document.createElement('button');
    const gradeClass = getGradeClass(cls);
    btn.className = `control-btn ${gradeClass} status-${clsInfo.status}`;
    btn.textContent = cls;

    btn.addEventListener('click', () => triggerClassDismissal(cls));
    gridContainer.appendChild(btn);
  });
}

async function triggerClassDismissal(className) {
  try {
    showLoading(true);
    await updateDoc(DISMISSAL_DOC_REF, {
      [`${className}.status`]: 'active',
      [`${className}.timestamp`]: Date.now()
    });
  } catch (e) {
    const initialData = {};
    initialData[className] = { status: 'active', timestamp: Date.now() };
    await setDoc(DISMISSAL_DOC_REF, initialData, { merge: true });
  } finally {
    showLoading(false);
  }
}

async function resetAllClasses() {
  if (typeof Swal !== 'undefined') {
    const result = await Swal.fire({
      title: '確定重置所有班別？',
      text: '此操作會將所有班別恢復為預設狀態。',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: '確定重置',
      cancelButtonText: '取消'
    });

    if (result.isConfirmed) {
      showLoading(true);
      const resetData = {};
      ALL_CLASSES.forEach(cls => {
        resetData[cls] = { status: 'waiting', timestamp: 0 };
      });
      await setDoc(DISMISSAL_DOC_REF, resetData);
      showLoading(false);
      Swal.fire('已重置！', '所有班別狀態已清空。', 'success');
    }
  }
}

showLoading(true);
initRealtimeListener();