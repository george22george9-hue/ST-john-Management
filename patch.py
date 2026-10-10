import io
import re

filepath = r'c:\الكنيسة\خطة الأجتماع\برنامج الحضور\app.js'
with io.open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

firebase_code = """// --- Firebase Setup & Cloud Sync ---
const firebaseConfig = {
  apiKey: "AIzaSyDrwfDJ3dq-C-xYnF3tF4sd1-EE_JimOgI",
  authDomain: "st-john-g.firebaseapp.com",
  projectId: "st-john-g",
  storageBucket: "st-john-g.firebasestorage.app",
  messagingSenderId: "646578600431",
  appId: "1:646578600431:web:4c6819aa71558b79711e1a"
};

let db;
let isFirebaseInitialized = false;
let isSyncingFromCloud = false;
let syncTimeout = null;
let clientId = localStorage.getItem('church_client_id');
if (!clientId) {
    clientId = Math.random().toString(36).substr(2, 9);
    localStorage.setItem('church_client_id', clientId);
}

if (typeof firebase !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    db.enablePersistence().catch(err => console.log('Persistence error', err));
    isFirebaseInitialized = true;
    startFirebaseSync();
}

function pushToCloud() {
    if (!isFirebaseInitialized || isSyncingFromCloud) return;

    const data = {
        members: getMembers(),
        attendance: getAttendanceRecords(),
        visitations: getVisitations(),
        servantRecords: getServantRecords(),
        waTasks: getWaTasks(),
        competitions: getCompetitions(),
        dayTypes: getDayTypes(),
        auth: localStorage.getItem('church_app_auth') || '{}',
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
        clientId: clientId,
        pushId: Math.random().toString(36).substr(2, 9)
    };

    localStorage.setItem('last_push_id', data.pushId);

    db.collection('church_db').doc('main_data').set(data).then(() => {
        console.log("Pushed to cloud successfully");
    }).catch(e => console.error("Push failed", e));
}

function triggerCloudSync() {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(pushToCloud, 1000);
}

function startFirebaseSync() {
    db.collection('church_db').doc('main_data').onSnapshot(doc => {
        if (!doc.exists) {
            pushToCloud();
            return;
        }
        
        const cloudData = doc.data();
        const lastPushId = localStorage.getItem('last_push_id');
        
        if (cloudData.pushId === lastPushId || (cloudData.clientId === clientId && !lastPushId)) {
            return; // Ignore our own pushes
        }

        isSyncingFromCloud = true;

        if (cloudData.members) localStorage.setItem('church_attendance_members', JSON.stringify(cloudData.members));
        if (cloudData.attendance) localStorage.setItem('church_attendance_records', JSON.stringify(cloudData.attendance));
        if (cloudData.visitations) localStorage.setItem('church_attendance_visitations', JSON.stringify(cloudData.visitations));
        if (cloudData.servantRecords) localStorage.setItem('church_servant_records', JSON.stringify(cloudData.servantRecords));
        if (cloudData.waTasks) localStorage.setItem('church_wa_tasks', JSON.stringify(cloudData.waTasks));
        if (cloudData.competitions) localStorage.setItem('church_competitions_data', JSON.stringify(cloudData.competitions));
        if (cloudData.dayTypes) localStorage.setItem('church_day_types', JSON.stringify(cloudData.dayTypes));
        if (cloudData.auth) localStorage.setItem('church_app_auth', cloudData.auth);
        
        localStorage.setItem('last_push_id', cloudData.pushId || '');
        
        if (typeof renderMembers === 'function') renderMembers();
        if (typeof renderAttendance === 'function') renderAttendance();
        if (typeof refreshDashboard === 'function') refreshDashboard();
        if (typeof renderCompetitions === 'function') renderCompetitions();
        if (typeof setupAdminTable === 'function') setupAdminTable();
        
        showToast('تم استقبال تحديثات من الخادم!', 'success');
        
        setTimeout(() => { isSyncingFromCloud = false; }, 1000);
    });
}

// --- Database / LocalStorage Wrapper ---
"""

content = content.replace('// --- Database / LocalStorage Wrapper ---', firebase_code)

def add_sync(match):
    return match.group(0) + '\n    if (typeof triggerCloudSync === "function") triggerCloudSync();'

# For saveMembers
pattern1 = r'catch \(e\) \{ if \(e\.name === \'QuotaExceededError\'\) alert\([^\)]+\); \}'
content = re.sub(pattern1, add_sync, content)

# For saveDayTypes
pattern2 = r'catch \(e\) \{ \}'
content = re.sub(pattern2, add_sync, content)

# For saveAuthData
pattern3 = r'catch \(e\) \{\}'
content = re.sub(pattern3, add_sync, content)

with io.open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
