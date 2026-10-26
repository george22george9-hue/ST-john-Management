// Legacy password bypass and cleanup flags
window.isAdminUnlocked = true;
window.isServantNotesUnlocked = true;
try {
    localStorage.removeItem('church_servant_notes_pass');
    localStorage.removeItem('church_servant_notes_unlocked');
    localStorage.removeItem('church_admin_unlocked');
} catch (e) {}

// --- Custom UI Alerts & Prompts ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    let icon = 'ph-check-circle';
    if (type === 'error') icon = 'ph-warning-octagon';
    if (type === 'warning') icon = 'ph-warning-circle';

    toast.innerHTML = `<i class="ph ${icon}" style="font-size: 1.4rem;"></i> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
window.showToast = showToast;

window.alert = function (msg) {
    showToast(msg, 'warning');
};

window.customConfirm = function (message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('custom-confirm-modal');
        if (!modal) { resolve(confirm(message)); return; }

        document.getElementById('confirm-message').innerText = message;
        modal.classList.add('active');

        const btnYes = document.getElementById('btn-confirm-yes');
        const btnNo = document.getElementById('btn-confirm-no');

        const cleanup = () => {
            modal.classList.remove('active');
            btnYes.removeEventListener('click', onYes);
            btnNo.removeEventListener('click', onNo);
        };
        const onYes = () => { cleanup(); resolve(true); };
        const onNo = () => { cleanup(); resolve(false); };

        btnYes.addEventListener('click', onYes);
        btnNo.addEventListener('click', onNo);
    });
};

window.customPrompt = function (message, defaultValue = '') {
    return new Promise((resolve) => {
        const modal = document.getElementById('custom-prompt-modal');
        if (!modal) { resolve(prompt(message, defaultValue)); return; }

        document.getElementById('prompt-message').innerText = message;
        const input = document.getElementById('prompt-input');
        input.value = defaultValue;
        modal.classList.add('active');
        input.focus();

        const btnSave = document.getElementById('btn-prompt-save');
        const btnCancel = document.getElementById('btn-prompt-cancel');

        const onSave = () => { cleanup(); resolve(input.value); };
        const onCancel = () => { cleanup(); resolve(null); };
        const onEnter = (e) => { if (e.key === 'Enter') onSave(); };

        const cleanup = () => {
            modal.classList.remove('active');
            btnSave.removeEventListener('click', onSave);
            btnCancel.removeEventListener('click', onCancel);
            input.removeEventListener('keydown', onEnter);
        };

        btnSave.addEventListener('click', onSave);
        btnCancel.addEventListener('click', onCancel);
        input.addEventListener('keydown', onEnter);
    });
};

// --- Firebase Setup & Cloud Sync ---
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
let isPushingToCloud = false;
let isCloudPushPending = false;
let syncTimeout = null;
let clientId = localStorage.getItem('church_client_id');
if (!clientId) {
    clientId = Math.random().toString(36).substr(2, 9);
    localStorage.setItem('church_client_id', clientId);
}

// Helpers for deleted tracking so merge won't resurrect items intentionally deleted
function recordDeletedBookingId(bookingId) {
    if (!bookingId) return;
    try {
        const key = 'church_deleted_booking_ids';
        let list = JSON.parse(localStorage.getItem(key) || '[]');
        if (!list.includes(bookingId)) {
            list.push(bookingId);
            if (list.length > 300) list = list.slice(list.length - 300);
            localStorage.setItem(key, JSON.stringify(list));
        }
    } catch(e) {}
}

function recordDeletedTripId(tripId) {
    if (!tripId) return;
    try {
        const key = 'church_deleted_trip_ids';
        let list = JSON.parse(localStorage.getItem(key) || '[]');
        if (!list.includes(tripId)) {
            list.push(tripId);
            if (list.length > 100) list = list.slice(list.length - 100);
            localStorage.setItem(key, JSON.stringify(list));
        }
    } catch(e) {}
}

// Smart merger for trips ensuring locally registered bookings are NEVER overwritten or lost
function mergeTrips(localTrips, cloudTrips) {
    if (!Array.isArray(cloudTrips)) return { mergedTrips: Array.isArray(localTrips) ? localTrips : [], hasLocalUnsyncedBookings: false };
    if (!Array.isArray(localTrips) || localTrips.length === 0) return { mergedTrips: cloudTrips, hasLocalUnsyncedBookings: false };

    let deletedBookingIds = [];
    let deletedTripIds = [];
    try { deletedBookingIds = JSON.parse(localStorage.getItem('church_deleted_booking_ids') || '[]'); } catch(e) {}
    try { deletedTripIds = JSON.parse(localStorage.getItem('church_deleted_trip_ids') || '[]'); } catch(e) {}
    const deletedBSet = new Set(deletedBookingIds);
    const deletedTSet = new Set(deletedTripIds);

    let hasLocalUnsyncedBookings = false;
    const localMap = new Map();
    localTrips.forEach(t => { if (t && t.id) localMap.set(t.id, t); });
    const cloudMap = new Map();
    cloudTrips.forEach(t => { if (t && t.id) cloudMap.set(t.id, t); });

    const merged = [];

    cloudTrips.forEach(cTrip => {
        if (!cTrip || !cTrip.id) return;
        if (deletedTSet.has(cTrip.id)) {
            hasLocalUnsyncedBookings = true;
            return; // Was deleted locally
        }

        const lTrip = localMap.get(cTrip.id);
        if (!lTrip) {
            // New trip from cloud
            const validBookings = (cTrip.bookings || []).filter(b => b && b.id && !deletedBSet.has(b.id));
            merged.push({ ...cTrip, bookings: validBookings });
            return;
        }

        // Trip exists both locally and in cloud: merge bookings
        const mergedTrip = { ...cTrip };
        const cBookings = Array.isArray(cTrip.bookings) ? cTrip.bookings : [];
        const lBookings = Array.isArray(lTrip.bookings) ? lTrip.bookings : [];

        const mergedBookings = [];
        const seenBookingIds = new Set();

        cBookings.forEach(cb => {
            if (!cb || !cb.id) return;
            if (deletedBSet.has(cb.id)) {
                hasLocalUnsyncedBookings = true;
                return; // Deleted locally
            }
            const lb = lBookings.find(b => b && b.id === cb.id);
            if (lb) {
                const lbTime = lb.updatedAt || lb.createdAt || '';
                const cbTime = cb.updatedAt || cb.createdAt || '';
                if (lbTime > cbTime) {
                    mergedBookings.push(lb);
                    hasLocalUnsyncedBookings = true;
                } else {
                    mergedBookings.push(cb);
                }
            } else {
                mergedBookings.push(cb);
            }
            seenBookingIds.add(cb.id);
        });

        // Add bookings registered locally that cloud doesn't have yet!
        lBookings.forEach(lb => {
            if (!lb || !lb.id) return;
            if (deletedBSet.has(lb.id)) return;
            if (!seenBookingIds.has(lb.id)) {
                mergedBookings.push(lb);
                seenBookingIds.add(lb.id);
                hasLocalUnsyncedBookings = true;
            }
        });

        mergedTrip.bookings = mergedBookings;
        merged.push(mergedTrip);
    });

    // Check if there are locally created trips not yet in cloud
    localTrips.forEach(lTrip => {
        if (!lTrip || !lTrip.id) return;
        if (deletedTSet.has(lTrip.id)) return;
        if (!cloudMap.has(lTrip.id)) {
            merged.unshift(lTrip);
            hasLocalUnsyncedBookings = true;
        }
    });

    return { mergedTrips: merged, hasLocalUnsyncedBookings };
}

// Dedicated direct atomic sync for trips
let isSyncingTrips = false;
let isTripsSyncPending = false;

function syncTripsToCloud(trips) {
    if (!isFirebaseInitialized || !db) {
        localStorage.setItem('church_trips_pending_sync', 'true');
        return;
    }

    if (isSyncingTrips) {
        isTripsSyncPending = true;
        return;
    }

    isSyncingTrips = true;
    const currentTrips = trips || getTrips();
    const pushId = Math.random().toString(36).substr(2, 9);

    const payload = {
        trips: currentTrips,
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
        clientId: clientId,
        pushId: pushId
    };

    db.collection('church_db').doc('main_data').set(payload, { merge: true })
        .then(() => {
            localStorage.setItem('last_push_id', pushId);
            localStorage.removeItem('church_trips_pending_sync');
            console.log('[Firestore] Trips synced to cloud successfully');
        })
        .catch(err => {
            console.error('[Firestore] Trips sync failed:', err);
            localStorage.setItem('church_trips_pending_sync', 'true');
            if (typeof showToast === 'function') {
                showToast('تنبيه: تعذر إرسال الحجز للسحابة حالياً، سيتم المزامنة تلقائياً عند استقرار الاتصال', 'warning');
            }
        })
        .finally(() => {
            isSyncingTrips = false;
            if (isTripsSyncPending) {
                isTripsSyncPending = false;
                syncTripsToCloud(getTrips());
            }
        });
}

if (typeof firebase !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    db.enablePersistence().catch(err => console.log('Persistence error', err));
    isFirebaseInitialized = true;
    startFirebaseSync();
    if (localStorage.getItem('church_trips_pending_sync') === 'true') {
        setTimeout(() => syncTripsToCloud(getTrips()), 500);
    }
}

function pushToCloud() {
    if (!isFirebaseInitialized) return;
    if (isSyncingFromCloud || isPushingToCloud) {
        isCloudPushPending = true;
        return;
    }

    isPushingToCloud = true;

    const data = {
        members: getMembers(),
        attendance: getAttendanceRecords(),
        visitations: getVisitations(),
        servantRecords: getServantRecords(),
        servantNotes: getServantNotes(),
        waTasks: getWaTasks(),
        competitions: getCompetitions(),
        trips: (typeof getTrips === 'function') ? getTrips() : [],
        dayTypes: getDayTypes(),
        auth: localStorage.getItem('church_app_auth') || '{}',
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
        clientId: clientId,
        pushId: Math.random().toString(36).substr(2, 9)
    };

    // التحقق من حجم البيانات لحماية السحابة من تجاوز حد الـ 1 ميجابايت (Firestore 1MB limit)
    try {
        const payloadStr = JSON.stringify(data);
        const approxBytes = new Blob([payloadStr]).size;
        if (approxBytes > 850000) {
            console.warn(`[Firestore Alert] حجم بيانات السحابة قارب على الامتلاء: ${Math.round(approxBytes / 1024)} KB`);
            if (typeof showToast === 'function' && approxBytes > 950000) {
                showToast('تنبيه: حجم بيانات السحابة اقترب من الحد الأقصى (1MB)! يرجى أخذ نسخة احتياطية.', 'warning');
            }
        }
    } catch (e) {}

    db.collection('church_db').doc('main_data').set(data).then(() => {
        localStorage.setItem('last_push_id', data.pushId);
        console.log("Pushed to cloud successfully");
    }).catch(e => {
        console.error("Push failed", e);
        if (typeof showToast === 'function') {
            showToast('تعذر حفظ البيانات في السحابة: ' + (e.message || ''), 'error');
        }
    }).finally(() => {
        isPushingToCloud = false;
        if (isCloudPushPending) {
            isCloudPushPending = false;
            setTimeout(pushToCloud, 200);
        }
    });
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
        
        // Handle legacy cloud data from old app versions
        if (!cloudData.pushId) {
            if (getMembers().length > 0) {
                pushToCloud(); // Our local data is better than old cloud data
            }
            return;
        }

        if (cloudData.pushId === lastPushId) {
            return; // Ignore our own pushes
        }

        isSyncingFromCloud = true;

        try {
            if (cloudData.members && Array.isArray(cloudData.members) && (cloudData.members.length > 0 || getMembers().length === 0)) {
                localStorage.setItem('church_attendance_members', JSON.stringify(cloudData.members));
            }
            if (cloudData.attendance) localStorage.setItem('church_attendance_records', JSON.stringify(cloudData.attendance));
            if (cloudData.visitations) localStorage.setItem('church_attendance_visitations', JSON.stringify(cloudData.visitations));
            if (cloudData.servantRecords) localStorage.setItem('church_servant_records', JSON.stringify(cloudData.servantRecords));
            if (cloudData.servantNotes) localStorage.setItem('church_servant_notes', JSON.stringify(cloudData.servantNotes));
            if (cloudData.waTasks) localStorage.setItem('church_wa_tasks', JSON.stringify(cloudData.waTasks));
            if (cloudData.competitions) localStorage.setItem('church_competitions_data', JSON.stringify(cloudData.competitions));

            // Smart Merge for Trips so locally registered bookings are NEVER lost on reload or sync!
            if (cloudData.trips && Array.isArray(cloudData.trips)) {
                const localTrips = getTrips();
                const { mergedTrips, hasLocalUnsyncedBookings } = mergeTrips(localTrips, cloudData.trips);
                localStorage.setItem(DB_KEY_TRIPS, JSON.stringify(mergedTrips));
                
                if (hasLocalUnsyncedBookings || localStorage.getItem('church_trips_pending_sync') === 'true') {
                    // Push local unsynced bookings to cloud immediately
                    setTimeout(() => syncTripsToCloud(mergedTrips), 100);
                }
            }

            if (cloudData.dayTypes) localStorage.setItem('church_day_types', JSON.stringify(cloudData.dayTypes));
            if (cloudData.auth) {
                localStorage.setItem('church_app_auth', cloudData.auth);
                if (typeof checkLoginAndApply === 'function') checkLoginAndApply();
            }
            
            localStorage.setItem('last_push_id', cloudData.pushId || '');

            // Update auth UI in case members or auth permissions updated
            if (typeof setupAuth === 'function') setupAuth();
            
            // استدعاء دوال الريندر الحقيقية لتحديث كل الشاشات فوراً
            if (typeof refreshDashboard === 'function') refreshDashboard();
            if (typeof updateAttendanceWorkspace === 'function') updateAttendanceWorkspace();
            if (typeof refreshFollowUp === 'function') refreshFollowUp();
            if (typeof refreshServantsDashboard === 'function') refreshServantsDashboard();
            if (typeof refreshServantsNotes === 'function') refreshServantsNotes();
            if (typeof renderCompetitions === 'function') renderCompetitions();
            if (typeof refreshTripsView === 'function') refreshTripsView();
            if (typeof setupAdminTable === 'function') setupAdminTable();
            if (typeof refreshAdminView === 'function') refreshAdminView();
            if (typeof refreshSummaryView === 'function') refreshSummaryView();
            if (typeof enforcePermissions === 'function') enforcePermissions();
            
            showToast('تم استقبال تحديثات من الخادم!', 'success');
        } catch(err) {
            console.error('Error applying cloud updates:', err);
        } finally {
            setTimeout(() => {
                isSyncingFromCloud = false;
                if (isCloudPushPending) {
                    isCloudPushPending = false;
                    pushToCloud();
                }
            }, 500);
        }
    });
}


// --- Database / LocalStorage Wrapper ---

const GOOGLE_SHEETS_URL = "https://script.google.com/macros/s/AKfycbyzRdLEzXS42WvMMckCIgDylb-QJp_ahX0FO0kS1MKBjE7us9Che5qViIdb0l6xswty/exec";

const DB_KEY_MEMBERS = 'church_attendance_members';
const DB_KEY_ATTENDANCE = 'church_attendance_records';
const DB_KEY_VISITATIONS = 'church_attendance_visitations';
const DB_KEY_SERVANT_RECORDS = 'church_servant_records';

function getMembers() {
    try { return JSON.parse(localStorage.getItem(DB_KEY_MEMBERS)) || []; } catch { return []; }
}

function saveMembers(members) {
    try { localStorage.setItem(DB_KEY_MEMBERS, JSON.stringify(members)); }
    catch (e) { if (e.name === 'QuotaExceededError') alert('مساحة التخزين ممتلئة! يرجى أخذ نسخة احتياطية ومسح بعض البيانات.'); }
    if (typeof triggerCloudSync === "function") triggerCloudSync();
    
}

const DB_KEY_COMPETITIONS = 'church_competitions_data';

function getCompetitions() {
    try { return JSON.parse(localStorage.getItem(DB_KEY_COMPETITIONS)) || []; } catch { return []; }
}

function saveCompetitions(comps) {
    try { localStorage.setItem(DB_KEY_COMPETITIONS, JSON.stringify(comps)); }
    catch (e) { if (e.name === 'QuotaExceededError') alert('مساحة التخزين ممتلئة! يرجى أخذ نسخة احتياطية ومسح بعض البيانات.'); }
    if (typeof triggerCloudSync === "function") triggerCloudSync();
    
}

const DB_KEY_TRIPS = 'church_trips_data';

function getTrips() {
    try {
        const raw = localStorage.getItem(DB_KEY_TRIPS);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveTrips(trips) {
    try {
        localStorage.setItem(DB_KEY_TRIPS, JSON.stringify(trips));
    } catch (e) {
        if (e.name === 'QuotaExceededError') alert('مساحة التخزين ممتلئة! يرجى أخذ نسخة احتياطية ومسح بعض البيانات القديمة.');
    }
    // مزامنة فورية ومستقلة للرحلات إلى السحابة لضمان حفظ الحجوزات وعدم ضياعها
    if (typeof syncTripsToCloud === "function") {
        syncTripsToCloud(trips);
    }
    if (typeof triggerCloudSync === "function") triggerCloudSync();
}


function getAttendanceRecords() {
    try { return JSON.parse(localStorage.getItem(DB_KEY_ATTENDANCE)) || {}; } catch { return {}; }
}

function saveAttendanceRecords(records) {
    try { localStorage.setItem(DB_KEY_ATTENDANCE, JSON.stringify(records)); }
    catch (e) { if (e.name === 'QuotaExceededError') alert('مساحة التخزين ممتلئة! يرجى أخذ نسخة احتياطية ومسح بعض البيانات.'); }
    if (typeof triggerCloudSync === "function") triggerCloudSync();
    
}

function getVisitations() {
    try { return JSON.parse(localStorage.getItem(DB_KEY_VISITATIONS)) || {}; } catch { return {}; }
}

function saveVisitations(records) {
    try { localStorage.setItem(DB_KEY_VISITATIONS, JSON.stringify(records)); }
    catch (e) { if (e.name === 'QuotaExceededError') alert('مساحة التخزين ممتلئة! يرجى أخذ نسخة احتياطية ومسح بعض البيانات.'); }
    if (typeof triggerCloudSync === "function") triggerCloudSync();
    
}

function getServantRecords() {
    try { return JSON.parse(localStorage.getItem(DB_KEY_SERVANT_RECORDS)) || {}; } catch { return {}; }
}

function saveServantRecords(records) {
    try { localStorage.setItem(DB_KEY_SERVANT_RECORDS, JSON.stringify(records)); }
    catch (e) { if (e.name === 'QuotaExceededError') alert('مساحة التخزين ممتلئة! يرجى أخذ نسخة احتياطية ومسح بعض البيانات.'); }
    if (typeof triggerCloudSync === "function") triggerCloudSync();
    
}

const DB_KEY_SERVANT_NOTES = 'church_servant_notes';

function getServantNotes() {
    try {
        const raw = localStorage.getItem(DB_KEY_SERVANT_NOTES);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
        if (typeof parsed === 'object') {
            const arr = [];
            for (const k in parsed) {
                if (Array.isArray(parsed[k])) arr.push(...parsed[k]);
            }
            return arr;
        }
        return [];
    } catch { return []; }
}

function saveServantNotes(notes) {
    try {
        localStorage.setItem(DB_KEY_SERVANT_NOTES, JSON.stringify(notes));
    } catch (e) {
        if (e.name === 'QuotaExceededError') alert('مساحة التخزين ممتلئة! يرجى أخذ نسخة احتياطية ومسح بعض البيانات.');
    }
    if (typeof triggerCloudSync === "function") triggerCloudSync();
}

const DB_KEY_WA_TASKS = 'church_wa_tasks';
const DB_KEY_DAY_TYPES = 'church_day_types';

function getDayTypes() {
    try { return JSON.parse(localStorage.getItem(DB_KEY_DAY_TYPES)) || {}; } catch { return {}; }
}

function saveDayTypes(types) {
    try { localStorage.setItem(DB_KEY_DAY_TYPES, JSON.stringify(types)); }
    catch (e) { }
    if (typeof triggerCloudSync === "function") triggerCloudSync();
    
}

function getWaTasks() {
    try { return JSON.parse(localStorage.getItem(DB_KEY_WA_TASKS)) || {}; } catch { return {}; }
}

function todayLocal() {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().split('T')[0];
}
function saveWaTasks(tasks) {
    try { localStorage.setItem(DB_KEY_WA_TASKS, JSON.stringify(tasks)); }
    catch (e) { if (e.name === 'QuotaExceededError') alert('مساحة التخزين ممتلئة! يرجى أخذ نسخة احتياطية ومسح بعض البيانات.'); }
    if (typeof triggerCloudSync === "function") triggerCloudSync();
    
}


// --- Authentication & Permissions ---
// One-time Admin Password Migration
try {
    let currentAuthData = getAuthData();
    if (currentAuthData && currentAuthData.admin && currentAuthData.admin.password === 'admin') {
        currentAuthData.admin.password = 'George-STjohn';
        saveAuthData(currentAuthData);
        if (typeof triggerCloudSync === 'function') triggerCloudSync();
    }
} catch(e) {}

function enforcePermissions() {
    if (currentUserRole === 'admin') {
        // Admin sees and can edit everything!
        document.querySelectorAll('[data-perm]').forEach(el => el.style.display = '');

        const btnSaveAttendance = document.getElementById('btn-save-attendance');
        if (btnSaveAttendance) btnSaveAttendance.style.display = '';
        const dayTypeSelect = document.getElementById('attendance-day-type');
        if (dayTypeSelect) dayTypeSelect.disabled = false;
        const bannerAttendance = document.getElementById('attendance-view-only-banner');
        if (bannerAttendance) bannerAttendance.style.display = 'none';

        const mobileSaveBar = document.getElementById('attendance-mobile-save-bar');
        const isAttActive = document.getElementById('attendance-view')?.classList.contains('active');
        if (mobileSaveBar) mobileSaveBar.style.display = isAttActive ? 'flex' : 'none';

        document.querySelectorAll('#attendance-members-list .btn-attend').forEach(b => {
            b.style.pointerEvents = '';
            b.style.opacity = '';
        });
        document.querySelectorAll('#attendance-servants-list input, #attendance-servants-list select').forEach(inp => {
            inp.disabled = false;
        });

        const btnAddPerson = document.getElementById('btn-add-person');
        if (btnAddPerson) btnAddPerson.style.display = '';
        const btnManageMembers = document.getElementById('btn-manage-members');
        if (btnManageMembers) btnManageMembers.style.display = '';
        const btnCreateComp = document.getElementById('btn-create-competition');
        if (btnCreateComp) btnCreateComp.style.display = '';
        const btnAddNoteMain = document.getElementById('btn-add-servant-note-main');
        if (btnAddNoteMain) btnAddNoteMain.style.display = '';
        const btnManagePerms = document.getElementById('btn-manage-permissions');
        if (btnManagePerms) {
            btnManagePerms.style.display = '';
            const card = btnManagePerms.closest('.settings-card-nocturne');
            if (card) card.style.display = '';
        }
        const btnImportData = document.getElementById('btn-import-data');
        if (btnImportData) {
            const card = btnImportData.closest('.settings-card-nocturne');
            if (card) card.style.display = '';
        }
        const btnSyncCloud = document.getElementById('btn-sync-cloud');
        if (btnSyncCloud) {
            const card = btnSyncCloud.closest('.settings-card-nocturne');
            if (card) card.style.display = '';
        }
        const btnManageMembersSettings = document.querySelector('#settings-view #btn-manage-members');
        if (btnManageMembersSettings) {
            const card = btnManageMembersSettings.closest('.settings-card-nocturne');
            if (card) card.style.display = '';
        }

        // Show all settings sections & reports for Admin
        ['settings-sec-security-divider', 'card-manage-members-settings', 'card-manage-perms-settings',
         'settings-sec-backup-divider', 'card-backup-export', 'card-backup-import', 'card-sync-cloud',
         'settings-reports-divider', 'card-report-monthly', 'card-report-visitation', 'card-export-excel'
        ].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = '';
        });
        const btnExportServantNotesAdmin = document.getElementById('btn-export-servant-notes');
        if (btnExportServantNotesAdmin) btnExportServantNotesAdmin.style.display = '';
        const btnPrintCompAdmin = document.getElementById('btn-print-comp-result');
        if (btnPrintCompAdmin) btnPrintCompAdmin.style.display = '';
        const btnCloudHeaderAdmin = document.querySelector('.settings-header-btn');
        if (btnCloudHeaderAdmin) btnCloudHeaderAdmin.style.display = '';
        const settingsTitleAdmin = document.querySelector('.settings-title');
        const settingsSubtitleAdmin = document.querySelector('.settings-subtitle');
        if (settingsTitleAdmin) settingsTitleAdmin.textContent = 'الإعدادات والبيانات';
        if (settingsSubtitleAdmin) settingsSubtitleAdmin.textContent = 'إدارة بيانات البرنامج والنسخ الاحتياطي';

        const btnDeleteComp = document.getElementById('btn-delete-comp') || document.getElementById('btn-delete-competition');
        if (btnDeleteComp) btnDeleteComp.style.display = '';

        const btnEditPhoneProfile = document.getElementById('btn-edit-phone') || document.getElementById('btn-edit-profile-phone');
        if (btnEditPhoneProfile) btnEditPhoneProfile.style.display = '';
        const btnEditGenderProfile = document.getElementById('btn-edit-gender');
        if (btnEditGenderProfile) btnEditGenderProfile.style.display = '';

        document.querySelectorAll('.btn-record-visit, .btn-primary-visit').forEach(b => {
            b.style.display = '';
        });

        document.querySelectorAll('#admin-members-tbody [data-action="edit"], #admin-members-tbody [data-action="delete"], #admin-cards-mobile [data-action="edit"], #admin-cards-mobile [data-action="delete"]').forEach(b => {
            b.style.display = '';
        });

        // Trips admin controls
        const btnCreateTripAdmin = document.getElementById('btn-create-trip');
        if (btnCreateTripAdmin) btnCreateTripAdmin.style.display = '';
        const btnCreateTripEmptyAdmin = document.getElementById('btn-create-trip-empty');
        if (btnCreateTripEmptyAdmin) btnCreateTripEmptyAdmin.style.display = '';
        const btnEditTripAdmin = document.getElementById('btn-edit-trip');
        if (btnEditTripAdmin) btnEditTripAdmin.style.display = '';
        const btnDeleteTripAdmin = document.getElementById('btn-delete-trip');
        if (btnDeleteTripAdmin) btnDeleteTripAdmin.style.display = '';
        const btnAddBookingAdmin = document.getElementById('btn-add-booking');
        if (btnAddBookingAdmin) btnAddBookingAdmin.style.display = '';
        const tripsBannerAdmin = document.getElementById('trips-view-only-banner');
        if (tripsBannerAdmin) tripsBannerAdmin.style.display = 'none';
        document.querySelectorAll('.trips-table [data-action], .bookings-mobile-cards [data-action]').forEach(b => {
            b.style.display = '';
        });

        return;
    }
    
    // 1. Generic [data-perm] elements
    document.querySelectorAll('[data-perm]').forEach(el => {
        const requiredPerm = el.getAttribute('data-perm');
        if (requiredPerm === 'admin-only') {
            el.style.display = (currentUserRole === 'admin') ? '' : 'none';
        } else if (!currentPermissions.includes(requiredPerm)) {
            el.style.display = 'none';
        } else {
            el.style.display = '';
        }
    });

    // 2. Attendance View (حضور وغياب)
    const canEditAttendance = currentPermissions.includes('attendance-edit');
    const btnSaveAttendance = document.getElementById('btn-save-attendance');
    const dayTypeSelect = document.getElementById('attendance-day-type');
    
    let bannerAttendance = document.getElementById('attendance-view-only-banner');
    if (!bannerAttendance) {
        bannerAttendance = document.createElement('div');
        bannerAttendance.id = 'attendance-view-only-banner';
        bannerAttendance.className = 'glass view-only-banner';
        bannerAttendance.innerHTML = '<i class="ph ph-eye" style="font-size: 1.2rem;"></i> وضع المشاهدة فقط: يمكنك استعراض الحضور ولكن لا تملك صلاحية التعديل أو الحفظ.';
        const ws = document.getElementById('attendance-workspace');
        if (ws) ws.insertBefore(bannerAttendance, ws.firstChild);
    }
    
    const mobileSaveBar = document.getElementById('attendance-mobile-save-bar');
    const isAttActive = document.getElementById('attendance-view')?.classList.contains('active');

    if (!canEditAttendance) {
        if (btnSaveAttendance) btnSaveAttendance.style.display = 'none';
        if (dayTypeSelect) dayTypeSelect.disabled = true;
        if (bannerAttendance) bannerAttendance.style.display = 'flex';
        document.querySelectorAll('#attendance-members-list .btn-attend').forEach(b => {
            b.style.pointerEvents = 'none';
            b.style.opacity = '0.85';
        });
        document.querySelectorAll('#attendance-servants-list input, #attendance-servants-list select').forEach(inp => {
            inp.disabled = true;
        });
        if (mobileSaveBar) mobileSaveBar.style.display = 'none';
    } else {
        if (btnSaveAttendance) btnSaveAttendance.style.display = '';
        if (dayTypeSelect) dayTypeSelect.disabled = false;
        if (bannerAttendance) bannerAttendance.style.display = 'none';
        document.querySelectorAll('#attendance-members-list .btn-attend').forEach(b => {
            b.style.pointerEvents = '';
            b.style.opacity = '';
        });
        document.querySelectorAll('#attendance-servants-list input, #attendance-servants-list select').forEach(inp => {
            inp.disabled = false;
        });
        if (mobileSaveBar) mobileSaveBar.style.display = isAttActive ? 'flex' : 'none';
    }

    // 3. Follow-up & Care View (المتابعة والافتقاد)
    const isAdmin = (currentUserRole === 'admin');
    const canEditFollowup = currentPermissions.includes('followup-edit');
    const btnBulkVisit = document.getElementById('btn-open-bulk-visit');
    const btnWaTask = document.getElementById('btn-open-wa-task');
    const btnCopyAbsent = document.getElementById('btn-copy-absent-last');
    const btnCopyNoVisit = document.getElementById('btn-copy-no-visit');
    const btnRecordVisitProfile = document.getElementById('btn-open-record-visit');
    const btnEditPhoneProfile = document.getElementById('btn-edit-phone') || document.getElementById('btn-edit-profile-phone');
    const btnEditGenderProfile = document.getElementById('btn-edit-gender');

    // هذه الإجراءات خاصة بالأدمن فقط: نسخ غياب آخر اجتماع، نسخ تأخر الافتقاد، افتقاد جماعي، تكليف واتساب
    if (btnBulkVisit) btnBulkVisit.style.display = isAdmin ? '' : 'none';
    if (btnWaTask) btnWaTask.style.display = isAdmin ? '' : 'none';
    if (btnCopyAbsent) btnCopyAbsent.style.display = isAdmin ? '' : 'none';
    if (btnCopyNoVisit) btnCopyNoVisit.style.display = isAdmin ? '' : 'none';

    // تسجيل الافتقاد الفردي وتعديل الهاتف متاح للأدمن أو الخادم الحاصل على صلاحية الافتقاد
    if (btnRecordVisitProfile) btnRecordVisitProfile.style.display = (isAdmin || canEditFollowup) ? '' : 'none';
    if (btnEditPhoneProfile) btnEditPhoneProfile.style.display = (isAdmin || canEditFollowup) ? '' : 'none';
    if (btnEditGenderProfile) btnEditGenderProfile.style.display = (isAdmin || canEditFollowup) ? '' : 'none';

    document.querySelectorAll('.btn-record-visit, .btn-primary-visit').forEach(b => {
        b.style.display = (isAdmin || canEditFollowup) ? '' : 'none';
    });

    // 4. Competitions View (المسابقات)
    const canEditCompetitions = currentPermissions.includes('competitions-edit');
    const btnCreateComp = document.getElementById('btn-create-competition');
    const btnAddRound = document.getElementById('btn-add-comp-round');
    const btnFinishComp = document.getElementById('btn-finish-comp');
    const btnDeleteComp = document.getElementById('btn-delete-comp') || document.getElementById('btn-delete-competition');

    if (btnCreateComp) btnCreateComp.style.display = canEditCompetitions ? '' : 'none';
    if (btnAddRound) btnAddRound.style.display = canEditCompetitions ? '' : 'none';
    if (btnFinishComp) btnFinishComp.style.display = canEditCompetitions ? '' : 'none';
    if (btnDeleteComp) btnDeleteComp.style.display = canEditCompetitions ? '' : 'none';

    // 4.5 Trips & Conferences View (الرحلات والمؤتمرات)
    const canEditTrips = currentPermissions.includes('trips-edit');
    const btnCreateTrip = document.getElementById('btn-create-trip');
    const btnCreateTripEmpty = document.getElementById('btn-create-trip-empty');
    const btnEditTrip = document.getElementById('btn-edit-trip');
    const btnDeleteTrip = document.getElementById('btn-delete-trip');
    const btnAddBooking = document.getElementById('btn-add-booking');
    const tripsBanner = document.getElementById('trips-view-only-banner');

    if (btnCreateTrip) btnCreateTrip.style.display = canEditTrips ? '' : 'none';
    if (btnCreateTripEmpty) btnCreateTripEmpty.style.display = canEditTrips ? '' : 'none';
    if (btnEditTrip) btnEditTrip.style.display = canEditTrips ? '' : 'none';
    if (btnDeleteTrip) btnDeleteTrip.style.display = canEditTrips ? '' : 'none';
    if (btnAddBooking) btnAddBooking.style.display = canEditTrips ? '' : 'none';
    if (tripsBanner) tripsBanner.style.display = canEditTrips ? 'none' : 'flex';

    document.querySelectorAll('.trips-table [data-action], .bookings-mobile-cards [data-action]').forEach(b => {
        b.style.display = canEditTrips ? '' : 'none';
    });

    // 5. Admin View (قاعدة البيانات)
    const canEditAdmin = currentPermissions.includes('admin-edit');
    const btnAddPerson = document.getElementById('btn-add-person');
    const btnManageMembers = document.getElementById('btn-manage-members');

    if (btnAddPerson) btnAddPerson.style.display = canEditAdmin ? '' : 'none';
    if (btnManageMembers) btnManageMembers.style.display = canEditAdmin ? '' : 'none';

    document.querySelectorAll('#admin-members-tbody [data-action="edit"], #admin-members-tbody [data-action="delete"], #admin-cards-mobile [data-action="edit"], #admin-cards-mobile [data-action="delete"]').forEach(b => {
        b.style.display = canEditAdmin ? '' : 'none';
    });

    // 6. Servants Notes View (ملاحظات الخدام)
    const canEditNotes = currentPermissions.includes('servants-notes-edit');
    const btnAddNoteMain = document.getElementById('btn-add-servant-note-main');
    const btnHistQuickAdd = document.getElementById('btn-history-quick-add');

    if (btnAddNoteMain) btnAddNoteMain.style.display = canEditNotes ? '' : 'none';
    if (btnHistQuickAdd) btnHistQuickAdd.style.display = canEditNotes ? '' : 'none';

    document.querySelectorAll('.servant-note-card button').forEach(b => {
        if (b.innerText && b.innerText.includes('إضافة ملاحظة')) {
            b.style.display = canEditNotes ? '' : 'none';
        }
    });
    document.querySelectorAll('.note-history-item button').forEach(b => {
        b.style.display = canEditNotes ? '' : 'none';
    });

    // 7. Settings & Backup (الإعدادات والنسخ)
    const canSettings = (currentUserRole === 'admin') || currentPermissions.includes('settings-view');
    const secSecurityDivider = document.getElementById('settings-sec-security-divider');
    const cardManageMembers = document.getElementById('card-manage-members-settings');
    const cardManagePerms = document.getElementById('card-manage-perms-settings');
    const secBackupDivider = document.getElementById('settings-sec-backup-divider');
    const cardBackupExport = document.getElementById('card-backup-export');
    const cardBackupImport = document.getElementById('card-backup-import');
    const cardSyncCloud = document.getElementById('card-sync-cloud');
    const btnCloudHeader = document.querySelector('.settings-header-btn');

    if (secSecurityDivider) secSecurityDivider.style.display = (currentUserRole === 'admin') ? '' : 'none';
    if (cardManageMembers) cardManageMembers.style.display = (currentUserRole === 'admin' || canEditAdmin) ? '' : 'none';
    if (cardManagePerms) cardManagePerms.style.display = (currentUserRole === 'admin') ? '' : 'none';

    if (secBackupDivider) secBackupDivider.style.display = canSettings ? '' : 'none';
    if (cardBackupExport) cardBackupExport.style.display = canSettings ? '' : 'none';
    if (cardBackupImport) cardBackupImport.style.display = (currentUserRole === 'admin') ? '' : 'none';
    if (cardSyncCloud) cardSyncCloud.style.display = (currentUserRole === 'admin') ? '' : 'none';
    if (btnCloudHeader) btnCloudHeader.style.display = (currentUserRole === 'admin') ? '' : 'none';

    const settingsTitle = document.querySelector('.settings-title');
    const settingsSubtitle = document.querySelector('.settings-subtitle');
    if (settingsTitle && settingsSubtitle) {
        if (!canSettings && currentPermissions.includes('reports-view')) {
            settingsTitle.textContent = 'التقارير والمخرجات';
            settingsSubtitle.textContent = 'استخراج وطباعة تقارير الحضور والافتقاد وملفات الإكسيل';
        } else {
            settingsTitle.textContent = 'الإعدادات والبيانات';
            settingsSubtitle.textContent = 'إدارة بيانات البرنامج والنسخ الاحتياطي';
        }
    }

    // 8. Reports & Printing Permissions (التقارير والمخرجات)
    const canPrintReports = (currentUserRole === 'admin') || currentPermissions.includes('reports-view');
    const secReportsDivider = document.getElementById('settings-reports-divider');
    const cardReportMonthly = document.getElementById('card-report-monthly');
    const cardReportVisitation = document.getElementById('card-report-visitation');
    const cardExportExcel = document.getElementById('card-export-excel');
    const btnExportNotes = document.getElementById('btn-export-servant-notes');
    const btnPrintComp = document.getElementById('btn-print-comp-result');

    if (secReportsDivider) secReportsDivider.style.display = canPrintReports ? '' : 'none';
    if (cardReportMonthly) cardReportMonthly.style.display = canPrintReports ? '' : 'none';
    if (cardReportVisitation) cardReportVisitation.style.display = canPrintReports ? '' : 'none';
    if (cardExportExcel) cardExportExcel.style.display = canPrintReports ? '' : 'none';
    if (btnExportNotes) btnExportNotes.style.display = canPrintReports ? '' : 'none';
    if (btnPrintComp) btnPrintComp.style.display = canPrintReports ? '' : 'none';
}

const DB_KEY_AUTH = 'church_app_auth';

function getAuthData() {
    try {
        const data = localStorage.getItem(DB_KEY_AUTH);
        if (data) {
            const parsed = JSON.parse(data);
            if (!parsed.supervisor) parsed.supervisor = { password: 'stjohn123', permissions: ['dashboard-view'] };
            
            // Force admin password migration
            if (parsed.admin && parsed.admin.password === 'admin') {
                parsed.admin.password = 'George-STjohn';
                // Try to save it back immediately to fix it
                localStorage.setItem(DB_KEY_AUTH, JSON.stringify(parsed));
            }

            // Ensure admin has full permissions
            const defaultAdminPerms = [
                'dashboard-view',
                'attendance-view', 'attendance-edit',
                'followup-view', 'followup-edit',
                'servants-dashboard-view', 'servants-dashboard-edit',
                'servants-notes-view', 'servants-notes-edit',
                'competitions-view', 'competitions-edit',
                'trips-view', 'trips-edit',
                'summary-view',
                'admin-view', 'admin-edit',
                'reports-view',
                'settings-view'
            ];

            if (parsed.admin) {
                if (!Array.isArray(parsed.admin.permissions) || parsed.admin.permissions.length === 0) {
                    parsed.admin.permissions = [...defaultAdminPerms];
                    localStorage.setItem(DB_KEY_AUTH, JSON.stringify(parsed));
                } else {
                    let updated = false;
                    defaultAdminPerms.forEach(p => {
                        if (!parsed.admin.permissions.includes(p)) {
                            parsed.admin.permissions.push(p);
                            updated = true;
                        }
                    });
                    if (updated) {
                        localStorage.setItem(DB_KEY_AUTH, JSON.stringify(parsed));
                    }
                }
            }
            
            return parsed;
        }
    } catch { }
    return {
        admin: { password: 'George-STjohn', permissions: ['dashboard-view', 'attendance-view', 'followup-view', 'servants-dashboard-view', 'servants-notes-view', 'competitions-view', 'trips-view', 'trips-edit', 'summary-view', 'admin-view', 'reports-view', 'settings-view'] },
        supervisor: { password: 'stjohn123', permissions: ['dashboard-view'] },
        servants: {}
    };
}

function saveAuthData(data) {
    try { localStorage.setItem(DB_KEY_AUTH, JSON.stringify(data)); } catch { }
    if (typeof triggerCloudSync === "function") triggerCloudSync();
}

let currentUserRole = null;
let currentPermissions = [];

function checkLoginAndApply() {
    const loggedInId = localStorage.getItem('church_logged_in_user');
    const authData = getAuthData();
    const loginModal = document.getElementById('login-modal-bg');

    if (loggedInId) {
        if (loggedInId === 'admin') {
            currentUserRole = 'admin';
            currentPermissions = (authData.admin && Array.isArray(authData.admin.permissions)) ? authData.admin.permissions : [
                'dashboard-view',
                'attendance-view', 'attendance-edit',
                'followup-view', 'followup-edit',
                'servants-dashboard-view', 'servants-dashboard-edit',
                'servants-notes-view', 'servants-notes-edit',
                'competitions-view', 'competitions-edit',
                'trips-view', 'trips-edit',
                'summary-view',
                'admin-view', 'admin-edit',
                'reports-view',
                'settings-view'
            ];
        } else if (loggedInId === 'supervisor') {
            currentUserRole = 'supervisor';
            currentPermissions = authData.supervisor.permissions;
        } else if (authData.servants[loggedInId]) {
            currentUserRole = 'servant';
            currentPermissions = authData.servants[loggedInId].permissions || ['dashboard-view'];
        } else {
            localStorage.removeItem('church_logged_in_user');
            currentUserRole = null;
            currentPermissions = [];
            document.documentElement.classList.remove('is-logged-in');
            document.documentElement.classList.add('is-not-logged-in');
            document.body.classList.add('not-logged-in');
            if (loginModal) loginModal.classList.add('active');
            return;
        }

        document.documentElement.classList.add('is-logged-in');
        document.documentElement.classList.remove('is-not-logged-in');
        document.body.classList.remove('not-logged-in');
        if (loginModal) loginModal.classList.remove('active');
        applyPermissions();
    } else {
        currentUserRole = null;
        currentPermissions = [];
        document.documentElement.classList.remove('is-logged-in');
        document.documentElement.classList.add('is-not-logged-in');
        document.body.classList.add('not-logged-in');
        if (loginModal) loginModal.classList.add('active');
    }
}

function hasPermissionForView(targetId) {
    if (!targetId) return false;
    if (currentUserRole === 'admin') return true;
    if (targetId === 'settings-view') {
        return currentPermissions.includes('settings-view') || currentPermissions.includes('reports-view');
    }
    const baseName = targetId.replace('-view', '');
    const hasDirectPerm = currentPermissions.includes(targetId);
    const hasViewPerm = currentPermissions.includes(baseName + '-view');
    const hasEditPerm = currentPermissions.includes(baseName + '-edit');
    return hasDirectPerm || hasViewPerm || hasEditPerm;
}
window.hasPermissionForView = hasPermissionForView;

function applyPermissions() {
    document.querySelectorAll('.sidebar-nav .nav-btn').forEach(btn => {
        const target = btn.getAttribute('data-target');
        const allowed = hasPermissionForView(target);
        btn.style.display = allowed ? 'flex' : 'none';
    });

    document.querySelectorAll('.mobile-nav-item[data-target]').forEach(mItem => {
        const target = mItem.getAttribute('data-target');
        const allowed = hasPermissionForView(target);
        mItem.style.display = allowed ? 'flex' : 'none';
    });

    // Update settings nav button label if user has only reports permission
    const settingsNavBtn = document.querySelector('.sidebar-nav .nav-btn[data-target="settings-view"]');
    if (settingsNavBtn) {
        if (currentUserRole !== 'admin' && !currentPermissions.includes('settings-view') && currentPermissions.includes('reports-view')) {
            settingsNavBtn.innerHTML = '<i class="ph ph-file-pdf"></i><span>التقارير والمخرجات</span>';
        } else {
            settingsNavBtn.innerHTML = '<i class="ph ph-gear"></i><span>الإعدادات والنسخ</span>';
        }
    }
    const mobileSettingsBtn = document.querySelector('.mobile-nav-item[data-target="settings-view"]');
    if (mobileSettingsBtn) {
        if (currentUserRole !== 'admin' && !currentPermissions.includes('settings-view') && currentPermissions.includes('reports-view')) {
            mobileSettingsBtn.innerHTML = '<i class="ph ph-file-pdf"></i><span>التقارير</span>';
        } else {
            mobileSettingsBtn.innerHTML = '<i class="ph ph-gear"></i><span>الإعدادات</span>';
        }
    }

    const activeSection = document.querySelector('.view-section.active');
    const activeTarget = activeSection ? activeSection.id : null;
    if (!activeTarget || !hasPermissionForView(activeTarget)) {
        const firstVisibleBtn = Array.from(document.querySelectorAll('.sidebar-nav .nav-btn')).find(b => b.style.display !== 'none');
        if (firstVisibleBtn) {
            const firstTarget = firstVisibleBtn.getAttribute('data-target');
            if (firstTarget && typeof window.navigateToView === 'function') {
                window.navigateToView(firstTarget);
            }
        }
    }
    
    // Make sure we enforce permissions immediately on load
    if (typeof enforcePermissions === 'function') {
        enforcePermissions();
    }
}

// --- Initial Data Seed ---

// --- App State ---
function formatDate(dateStr) {
    if (!dateStr || dateStr === '--' || dateStr.includes('لم')) return dateStr;
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return dateStr;
}

let currentChart = null;

// --- DOM Elements ---
const navBtns = document.querySelectorAll('.nav-btn');
const views = document.querySelectorAll('.view-section');

// Modals
const modalManageMembers = document.getElementById('manage-members-modal-bg');

// --- Small shared helpers ---
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function normalizeAr(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[\u064B-\u065F\u0670]/g, '')
        .replace(/[أإآ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .trim();
}

// (Duplicate showToast removed - defined at top with #toast-container)

// --- Navigation ---
window.navigateToView = async function(targetId) {
    if (!localStorage.getItem('church_logged_in_user') || !currentUserRole) {
        checkLoginAndApply();
        return;
    }
    if (!hasPermissionForView(targetId)) {
        showToast('عفواً، لا تملك صلاحية لفتح هذه الصفحة', 'warning');
        const firstVisibleBtn = Array.from(document.querySelectorAll('.sidebar-nav .nav-btn')).find(b => b.style.display !== 'none');
        if (firstVisibleBtn) {
            const fallback = firstVisibleBtn.getAttribute('data-target');
            if (fallback && fallback !== targetId && hasPermissionForView(fallback)) {
                return window.navigateToView(fallback);
            }
        }
        return;
    }

    // If mobile drawer is open, close it
    if (window.innerWidth <= 900) {
        const sidebar = document.querySelector('.sidebar');
        if (sidebar && sidebar.classList.contains('mobile-open')) {
            toggleMobileMenu();
        }
    }

    // Remove active classes
    navBtns.forEach(b => b.classList.remove('active'));
    views.forEach(v => v.classList.remove('active'));

    // Add active class to target sidebar button and section
    const targetBtn = document.querySelector(`.sidebar-nav .nav-btn[data-target="${targetId}"]`);
    if (targetBtn) targetBtn.classList.add('active');

    const targetEl = document.getElementById(targetId);
    if (targetEl) targetEl.classList.add('active');

    // Sync mobile bottom navigation active state
    document.querySelectorAll('.mobile-nav-item[data-target]').forEach(mItem => {
        mItem.classList.toggle('active', mItem.getAttribute('data-target') === targetId);
    });

    // Toggle Mobile Floating Save Bar
    const mobileSaveBar = document.getElementById('attendance-mobile-save-bar');
    if (mobileSaveBar) {
        const canEditAttendance = currentUserRole === 'admin' || currentPermissions.includes('attendance-edit');
        mobileSaveBar.style.display = (targetId === 'attendance-view' && canEditAttendance && currentAttendanceDate) ? 'flex' : 'none';
    }

    // View specific logic
    if (targetId === 'dashboard-view') refreshDashboard();
    if (targetId === 'followup-view') refreshFollowUp();
    if (targetId === 'attendance-view') updateAttendanceWorkspace();
    if (targetId === 'servants-dashboard-view') refreshServantsDashboard();
    if (targetId === 'servants-notes-view') refreshServantsNotes();
    if (targetId === 'summary-view') refreshSummaryView();
    if (targetId === 'competitions-view') { if (typeof renderCompetitions === 'function') renderCompetitions(); }
    if (targetId === 'trips-view') { if (typeof refreshTripsView === 'function') refreshTripsView(); }
    if (targetId === 'admin-view') refreshAdminView();

    window.scrollTo({ top: 0, behavior: 'smooth' });
};

function setupNavigation() {
    // Setup Mobile Bottom Navigation items
    document.querySelectorAll('.mobile-nav-item[data-target]').forEach(mItem => {
        mItem.addEventListener('click', () => {
            const target = mItem.getAttribute('data-target');
            if (target) window.navigateToView(target);
        });
    });

    // Mobile Floating Save Attendance Button
    const btnSaveMobile = document.getElementById('btn-save-attendance-mobile');
    if (btnSaveMobile) {
        btnSaveMobile.addEventListener('click', () => {
            const btnSaveAttendance = document.getElementById('btn-save-attendance');
            if (btnSaveAttendance) btnSaveAttendance.click();
        });
    }

    navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');
            if (targetId) window.navigateToView(targetId);
        });
    });
}

// --- Modals & Management Logic ---
function setupModals() {
    // Open Manage Members
    const btnManageMem = document.getElementById('btn-manage-members');
    if (btnManageMem) {
        btnManageMem.addEventListener('click', () => {
            if (currentUserRole !== 'admin' && !currentPermissions.includes('admin-edit')) {
                alert('عفواً، لا تملك صلاحية إدارة أو تعديل الأعضاء.');
                return;
            }
            populateDeleteList();
            if (modalManageMembers) modalManageMembers.classList.add('active');
        });
    }

    // Close
    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.target.closest('.modal-overlay').classList.remove('active');
        });
    });

    // Save Single Member
    const saveSingleMember = () => {
        if (currentUserRole !== 'admin' && !currentPermissions.includes('admin-edit')) {
            alert('عفواً، حسابك يملك صلاحية المشاهدة فقط ولا يمكنه إضافة أشخاص.');
            return;
        }

        const name = document.getElementById('new-member-name').value.trim();
        const address = document.getElementById('new-member-address') ? document.getElementById('new-member-address').value.trim() : '';
        const role = document.getElementById('new-member-role').value;
        const gender = document.getElementById('new-member-gender').value;
        if (!name) return alert('برجاء كتابة اسم الشخص');

        const members = getMembers();
        members.push({ id: Date.now().toString(), name, address, phone: '', role: role || 'member', gender: gender || 'male', addedAt: todayLocal() });
        saveMembers(members);

        document.getElementById('new-member-name').value = '';
        if (document.getElementById('new-member-address')) document.getElementById('new-member-address').value = '';
        refreshDashboard();
        populateDeleteList();
        alert('تمت الإضافة بنجاح');
    };

    document.getElementById('btn-save-member').addEventListener('click', saveSingleMember);
    ['new-member-name', 'new-member-address'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') saveSingleMember();
            });
        }
    });

    // Save Bulk Members
    document.getElementById('btn-save-bulk').addEventListener('click', () => {
        if (currentUserRole !== 'admin' && !currentPermissions.includes('admin-edit')) {
            alert('عفواً، حسابك يملك صلاحية المشاهدة فقط ولا يمكنه إضافة أشخاص.');
            return;
        }
        const text = document.getElementById('bulk-members-text').value;
        const gender = document.getElementById('bulk-members-gender')?.value || 'male';
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        if (lines.length === 0) return alert('لم يتم إدخال أسماء');

        const members = getMembers();
        lines.forEach(name => {
            members.push({ id: Date.now().toString() + Math.random().toString(36).substr(2, 5), name, phone: '', role: 'member', gender: gender, addedAt: todayLocal() });
        });
        saveMembers(members);

        document.getElementById('bulk-members-text').value = '';
        refreshDashboard();
        populateDeleteList();
        alert(`تمت إضافة ${lines.length} شخص بنجاح`);
    });
}

function populateDeleteList() {
    const list = document.getElementById('delete-members-list');
    list.innerHTML = '';
    let members = getMembers();
    members.sort((a, b) => a.name.localeCompare(b.name, 'ar'));

    members.forEach(m => {
        const row = document.createElement('div');
        row.className = 'member-attendance-row glass';
        row.style.marginBottom = '5px';
        const roleLabel = m.role === 'servant' ? 'خادم' : 'مخدوم';
        const toggleRoleText = m.role === 'servant' ? 'جعل مخدوم' : 'جعل خادم';
        row.innerHTML = `
            <div class="member-name" style="display: flex; flex-direction: column;">
                <div>
                    ${m.name} 
                    <span class="status-badge ${m.role === 'servant' ? 'badge-warning' : ''}" style="margin-right: 10px; font-size: 0.75rem;">${roleLabel}</span>
                </div>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">
                    <i class="ph ph-map-pin"></i> ${m.address || 'بدون عنوان / منطقة'}
                </div>
            </div>
            <div style="display: flex; gap: 5px; flex-wrap: wrap;">
                <button class="btn btn-outline" onclick="editMemberAddress('${m.id}')" style="padding: 5px 10px; display: inline-block;">العنوان</button>
                <button class="btn btn-outline" onclick="toggleMemberRole('${m.id}')" style="padding: 5px 10px; display: inline-block;">${toggleRoleText}</button>
                <button class="btn btn-danger" onclick="deleteMemberFromModal('${m.id}')" style="padding: 5px 15px; display: inline-block;">حذف</button>
            </div>
        `;
        list.appendChild(row);
    });
}

window.toggleMemberRole = function (id) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('admin-edit')) {
        alert('عفواً، لا تملك صلاحية تعديل رتبة الأعضاء.');
        return;
    }
    let members = getMembers();
    const memberIndex = members.findIndex(m => m.id === id);
    if (memberIndex !== -1) {
        members[memberIndex].role = members[memberIndex].role === 'servant' ? 'member' : 'servant';
        saveMembers(members);
        populateDeleteList();
    }
}

window.editMemberAddress = function (id) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('admin-edit')) {
        alert('عفواً، لا تملك صلاحية تعديل بيانات الأعضاء.');
        return;
    }
    let members = getMembers();
    const memberIndex = members.findIndex(m => m.id === id);
    if (memberIndex !== -1) {
        const currentAddress = members[memberIndex].address || '';
        const newAddress = prompt('أدخل المنطقة السكنية أو العنوان للمخدوم:', currentAddress);
        if (newAddress !== null) {
            members[memberIndex].address = newAddress.trim();
            saveMembers(members);
            populateDeleteList();
        }
    }
}

function deletePerson(id) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('admin-edit')) {
        alert('عفواً، حسابك يملك صلاحية المشاهدة فقط ولا يمكنه حذف الأعضاء.');
        return false;
    }
    const person = getMembers().find(m => m.id === id);
    if (!person) return false;
    if (!confirm(`حذف "${person.name}" نهائياً؟\nهيتمسح كمان من الحضور والافتقاد وكل السجلات.`)) return false;

    saveMembers(getMembers().filter(m => m.id !== id));

    const records = getAttendanceRecords();
    Object.keys(records).forEach(date => {
        records[date] = (records[date] || []).filter(attId => attId !== id);
    });
    saveAttendanceRecords(records);

    const visitations = getVisitations();
    if (visitations[id]) delete visitations[id];
    Object.keys(visitations).forEach(mId => {
        visitations[mId].forEach(v => {
            if (Array.isArray(v.servants)) {
                v.servants = v.servants.filter(sId => sId !== id);
            }
        });
    });
    saveVisitations(visitations);

    const servantRecords = getServantRecords();
    Object.keys(servantRecords).forEach(date => {
        if (servantRecords[date] && servantRecords[date][id]) {
            delete servantRecords[date][id];
        }
    });
    saveServantRecords(servantRecords);

    const waTasks = getWaTasks();
    Object.keys(waTasks).forEach(date => {
        if (waTasks[date].servants) waTasks[date].servants = waTasks[date].servants.filter(x => x !== id);
        if (waTasks[date].members) waTasks[date].members = waTasks[date].members.filter(x => x !== id);
    });
    saveWaTasks(waTasks);

    const comps = getCompetitions();
    let compsChanged = false;
    comps.forEach(comp => {
        if (comp.teams) {
            ['team1', 'team2', 'team3'].forEach(teamKey => {
                if (comp.teams[teamKey] && Array.isArray(comp.teams[teamKey].members)) {
                    const originalLength = comp.teams[teamKey].members.length;
                    comp.teams[teamKey].members = comp.teams[teamKey].members.filter(mId => mId !== id);
                    if (comp.teams[teamKey].members.length !== originalLength) compsChanged = true;
                }
            });
        }
        if (Array.isArray(comp.rounds)) {
            comp.rounds.forEach(round => {
                if (round.scores && round.scores[id] !== undefined) {
                    delete round.scores[id];
                    compsChanged = true;
                }
            });
        }
    });
    if (compsChanged) saveCompetitions(comps);

    return true;
}

window.deleteMemberFromModal = function (id) {
    if (!deletePerson(id)) return;
    populateDeleteList();
    if (typeof refreshDashboard === 'function') refreshDashboard();
    if (typeof refreshFollowUp === 'function') refreshFollowUp();
    if (typeof refreshAdminView === 'function') refreshAdminView();
    showToast('تم الحذف');
}

// --- Settings Logic ---
function setupSettings() {
    // Export Data
    document.getElementById('btn-export-data').addEventListener('click', () => {
        if (currentUserRole !== 'admin' && !currentPermissions.includes('settings-view')) {
            alert('عفواً، لا تملك صلاحية تحميل النسخة الاحتياطية.');
            return;
        }
        const data = {
            members: getMembers(),
            attendance: getAttendanceRecords(),
            visitations: getVisitations(),
            servantRecords: getServantRecords(),
            waTasks: getWaTasks(),
            competitions: getCompetitions(),
            trips: getTrips(),
            version: '1.0',
            exportedAt: todayLocal()
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `church_attendance_backup_${todayLocal()}.json`;
        a.click();
    });

    // Import Data
    const fileInput = document.getElementById('file-import');
    document.getElementById('btn-import-data').addEventListener('click', () => {
        if (currentUserRole !== 'admin') {
            alert('عفواً، استعادة النسخة الاحتياطية مقتصرة على مدير النظام فقط.');
            return;
        }
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const data = JSON.parse(event.target.result);
                if (data.members && Array.isArray(data.members)) {
                    if (confirm('هل أنت متأكد من استبدال البيانات الحالية بالبيانات الموجودة في الملف؟')) {
                        saveMembers(data.members);
                        if (data.attendance) saveAttendanceRecords(data.attendance);
                        if (data.visitations) saveVisitations(data.visitations);
                        if (data.servantRecords) saveServantRecords(data.servantRecords);
                        if (data.waTasks) saveWaTasks(data.waTasks);
                        if (data.competitions) saveCompetitions(data.competitions);
                        if (data.trips) saveTrips(data.trips);
                        alert('تم استعادة البيانات بنجاح!');

                        if (typeof refreshDashboard === 'function') refreshDashboard();
                        if (typeof refreshFollowUp === 'function') refreshFollowUp();
                        if (typeof refreshServantsDashboard === 'function') refreshServantsDashboard();
                        if (typeof refreshTripsView === 'function') refreshTripsView();
                        if (typeof refreshSummaryView === 'function') refreshSummaryView();
                        if (typeof refreshAdminView === 'function') refreshAdminView();
                        if (typeof populateDeleteList === 'function') populateDeleteList();
                    }
                } else {
                    alert('ملف النسخة الاحتياطية غير صالح (لا يحتوي على بيانات الأعضاء).');
                }
            } catch (err) {
                alert('خطأ في قراءة الملف. تأكد أنه ملف نسخة احتياطية صالح.');
            }
        };
        reader.readAsText(file);
    });

    function generateExportSheets(members, records, visitations, servantRecords) {
        const totalMeetings = Object.keys(records).length;
        const allDates = Object.keys(records).sort();

        // 1. السكرتارية
        const secretariatRows = members.map(m => {
            return {
                'الاسم': m.name,
                'الجنس': m.gender === 'female' ? 'أنثى' : 'ذكر',
                'المرحلة': m.education === 'graduate' ? 'خريج' : 'طالب',
                'المنطقة / العنوان': m.address || '',
                'النوع': m.role === 'servant' ? 'خادم' : 'مخدوم',
                'رقم التليفون': m.phone || '',
                'تاريخ الميلاد': m.birthdate ? formatDate(m.birthdate) : ''
            };
        });

        // 2. إحصائيات الحضور
        const attendanceRows = members.map(m => {
            let attendCount = 0;
            allDates.forEach(d => {
                if ((records[d] || []).includes(m.id)) attendCount++;
            });

            const pct = totalMeetings > 0 ? Math.round((attendCount / totalMeetings) * 100) : 0;

            let row = {
                'الاسم': m.name,
                'إجمالي الحضور': attendCount,
                'نسبة الحضور': pct + '%'
            };

            allDates.forEach(d => {
                const attended = (records[d] || []).includes(m.id);
                row[d] = attended ? true : false;
            });

            return row;
        });

        // 3. متابعة الافتقاد
        const visitationRows = [];
        Object.keys(visitations).forEach(memberId => {
            const mName = members.find(m => m.id === memberId)?.name || memberId;
            (visitations[memberId] || []).forEach(v => {
                const servantNames = Array.isArray(v.servants)
                    ? v.servants.map(sid => members.find(m => m.id === sid)?.name || sid).join(' / ')
                    : (v.servants || '');
                visitationRows.push({
                    'المخدوم': mName,
                    'التاريخ': formatDate(v.date) || '',
                    'طريقة الافتقاد': v.method || '',
                    'الخدام': servantNames,
                    'الإيجابيات': v.positives || '',
                    'المشاكل': v.problems || ''
                });
            });
        });
        visitationRows.sort((a, b) => (b['التاريخ'] || '').localeCompare(a['التاريخ'] || ''));

        // 4. متابعة الخدام
        const servantRows = [];
        if (servantRecords) {
            Object.keys(servantRecords).sort().forEach(date => {
                const dayData = servantRecords[date];
                if (!dayData || typeof dayData !== 'object') return;
                Object.keys(dayData).forEach(memberId => {
                    const s = dayData[memberId];
                    if (!s) return;
                    const sName = members.find(m => m.id === memberId)?.name || memberId;
                    servantRows.push({
                        'التاريخ': date,
                        'الخادم': sName,
                        'قدّم فقرة': s.presented ? 'نعم' : 'لا',
                        'قائد': s.leader ? 'نعم' : 'لا',
                        'وقت الوصول': s.arrival || '',
                        'الفقرة': s.topic || '',
                        'الملاحظات': s.notes || ''
                    });
                });
            });
        }

        // 5. إحصائيات عامة
        const summaryRows = allDates.map(d => {
            const dayAtt = records[d] || [];
            let mCount = 0;
            let sCount = 0;
            dayAtt.forEach(id => {
                const mem = members.find(m => m.id === id);
                if (mem) {
                    if (mem.role === 'servant') sCount++;
                    else mCount++;
                }
            });
            return {
                'التاريخ': d,
                'إجمالي الحضور': dayAtt.length,
                'حضور المخدومين': mCount,
                'حضور الخدام': sCount,
                'إجمالي المسجلين بالبرنامج': members.length
            };
        });

        return {
            'السكرتارية': secretariatRows,
            'إحصائيات الحضور': attendanceRows,
            'متابعة الافتقاد': visitationRows,
            'متابعة الخدام': servantRows,
            'إحصائيات عامة': summaryRows
        };
    }

    // Sync with Google Sheets
    document.getElementById('btn-sync-cloud').addEventListener('click', async () => {
        if (currentUserRole !== 'admin') {
            alert('عفواً، مزامنة السحابة مقتصرة على مدير النظام فقط.');
            return;
        }
        const btn = document.getElementById('btn-sync-cloud');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="ph ph-spinner"></i> جاري المزامنة...';
        btn.disabled = true;

        try {
            const members = getMembers();
            const records = getAttendanceRecords();
            const visitations = getVisitations();
            const servantRecords = getServantRecords();

            const totalMeetings = Object.keys(records).length;
            const allDates = Object.keys(records).sort();

            const payload = {
                sheets: generateExportSheets(members, records, visitations, servantRecords)
            };

            const body = JSON.stringify(payload);

            // نستخدم fetch مع mode: 'no-cors' لتخطي حجم البيانات المسموح في sendBeacon (64KB) ولتجنب مشاكل CORS
            try {
                await fetch(GOOGLE_SHEETS_URL, {
                    method: 'POST',
                    mode: 'no-cors',
                    headers: {
                        'Content-Type': 'text/plain;charset=utf-8',
                    },
                    body: body
                });
            } catch (err) {
                // Fallback: XHR بدون قراءة الرد
                await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', GOOGLE_SHEETS_URL, true);
                    xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
                    xhr.onload = resolve;
                    xhr.onerror = () => reject(new Error('XHR failed'));
                    xhr.send(body);
                });
            }

            showToast('تمت المزامنة بنجاح! 🎉', 'success');
            alert('تمت المزامنة بنجاح! ✅\nافتح شيت جوجل وهتلاقي الصفحات الأربعة اتحدثت.');

        } catch (error) {
            console.error('Sync error:', error);
            alert('فشل الاتصال ❌\n' + error.message);
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });



    // Export Excel
    const btnExportCsv = document.getElementById('btn-export-csv');
    if (btnExportCsv) {
        btnExportCsv.addEventListener('click', () => {
            if (currentUserRole !== 'admin' && !currentPermissions.includes('reports-view')) {
                alert('عفواً، لا تملك صلاحية استخراج ملف الإكسيل.');
                return;
            }
            if (typeof XLSX === 'undefined') {
                alert('عذراً، مكتبة الإكسيل لم يتم تحميلها بعد. تأكد من اتصالك بالإنترنت.');
                return;
            }

            const members = getMembers();
            const records = getAttendanceRecords();
            const visitations = getVisitations();

            const sheetsData = generateExportSheets(members, records, visitations, getServantRecords());

            // Build Workbook
            const wb = XLSX.utils.book_new();

            Object.keys(sheetsData).forEach(sheetName => {
                const ws = XLSX.utils.json_to_sheet(sheetsData[sheetName]);
                ws['!dir'] = 'rtl';
                XLSX.utils.book_append_sheet(wb, ws, sheetName);
            });

            XLSX.writeFile(wb, `بيانات_الاجتماع_${todayLocal()}.xlsx`);
        });
    }

    // Generate PDF Report
    document.getElementById('report-month').value = todayLocal().slice(0, 7); // Default to current month

    document.getElementById('btn-generate-pdf').addEventListener('click', () => {
        const monthVal = document.getElementById('report-month').value;
        if (!monthVal) return alert('برجاء اختيار الشهر');

        const [year, month] = monthVal.split('-');
        generatePDFReport(year, month);
    });

    // Generate Visitation PDF Report
    const reportMonthVisit = document.getElementById('report-month-visit');
    if (reportMonthVisit) reportMonthVisit.value = todayLocal().slice(0, 7);

    const btnGeneratePdfVisit = document.getElementById('btn-generate-pdf-visit');
    if (btnGeneratePdfVisit) {
        btnGeneratePdfVisit.addEventListener('click', () => {
            const monthVal = document.getElementById('report-month-visit').value;
            if (!monthVal) return alert('برجاء اختيار الشهر');

            const [year, month] = monthVal.split('-');
            generateVisitationPDFReport(year, month);
        });
    }
}

// --- Search Logic ---
function setupAdminFilters() {
    const filters = document.querySelectorAll('#admin-filters .filter-btn, #admin-filters .admin-filter-pill');
    filters.forEach(btn => {
        btn.addEventListener('click', () => {
            filters.forEach(f => f.classList.remove('active'));
            btn.classList.add('active');
            if (typeof refreshAdminView === 'function') refreshAdminView();
        });
    });
}

function setupSearchListeners() {
    // 1. Attendance Search
    const searchAttendance = document.getElementById('search-attendance');
    if (searchAttendance) {
        searchAttendance.addEventListener('input', (e) => {
            const rawQuery = (e.target.value || '').trim();
            const normQuery = typeof normalizeAr === 'function' ? normalizeAr(rawQuery) : rawQuery.toLowerCase();

            // Members list
            document.querySelectorAll('#attendance-members-list .member-attendance-row').forEach(row => {
                const nameText = row.querySelector('.member-name')?.textContent || '';
                const normName = typeof normalizeAr === 'function' ? normalizeAr(nameText) : nameText.toLowerCase();
                row.style.display = (!normQuery || normName.includes(normQuery)) ? 'flex' : 'none';
            });

            // Servants list
            document.querySelectorAll('#attendance-servants-list .servant-eval-row').forEach(row => {
                const nameText = (row.querySelector('.servant-eval-name')?.textContent || row.querySelector('.member-name')?.textContent || '');
                const normName = typeof normalizeAr === 'function' ? normalizeAr(nameText) : nameText.toLowerCase();
                const isAttended = row.getAttribute('data-attended') === 'true';
                row.style.display = ((!normQuery || normName.includes(normQuery)) && isAttended) ? 'flex' : 'none';
            });
            if (typeof updateServantsEvalNotice === 'function') {
                updateServantsEvalNotice();
            }
        });
    }

    // 4. Servants Dashboard Search
    const searchServants = document.getElementById('search-servants');
    if (searchServants) {
        searchServants.addEventListener('input', (e) => {
            const rawQuery = (e.target.value || '').trim();
            const normQuery = typeof normalizeAr === 'function' ? normalizeAr(rawQuery) : rawQuery.toLowerCase();
            document.querySelectorAll('#servants-dashboard-list tr').forEach(row => {
                const nameText = row.cells[0]?.textContent || '';
                const normName = typeof normalizeAr === 'function' ? normalizeAr(nameText) : nameText.toLowerCase();
                row.style.display = (!normQuery || normName.includes(normQuery)) ? 'table-row' : 'none';
            });
        });
    }

    // 5. Manage Members Search
    const searchManage = document.getElementById('search-manage');
    if (searchManage) {
        searchManage.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            document.querySelectorAll('#delete-members-list .member-attendance-row').forEach(row => {
                const name = row.querySelector('.member-name').textContent.toLowerCase();
                row.style.display = name.includes(query) ? 'flex' : 'none';
            });
        });
    }

    // 6. Admin View Search
    const searchAdmin = document.getElementById('search-admin');
    if (searchAdmin) {
        searchAdmin.addEventListener('input', () => {
            if (typeof refreshAdminView === 'function') refreshAdminView();
        });
    }
}


// --- Admin View Logic ---
window.refreshAdminView = function () {
    const tbody = document.getElementById('admin-members-tbody');
    if (!tbody) return;

    const all = getMembers().sort((a, b) => a.name.localeCompare(b.name, 'ar'));

    const activeFilterBtn = document.querySelector('#admin-filters .filter-btn.active, #admin-filters .admin-filter-pill.active');
    const filter = activeFilterBtn ? activeFilterBtn.getAttribute('data-filter') : 'all';
    const query = normalizeAr(document.getElementById('search-admin')?.value || '');

    const servantsCount = all.filter(m => m.role === 'servant').length;
    const counts = { all: all.length, member: all.length - servantsCount, servant: servantsCount };
    Object.keys(counts).forEach(key => {
        const el = document.getElementById(`count-${key}`);
        if (el) el.textContent = counts[key];
    });

    const rows = all.filter(m => {
        const type = m.role === 'servant' ? 'servant' : 'member';
        if (filter !== 'all' && type !== filter) return false;
        if (!query) return true;
        return normalizeAr(m.name).includes(query)
            || normalizeAr(m.address).includes(query)
            || String(m.phone || '').includes(query);
    });

    const resultCount = document.getElementById('admin-result-count');
    if (resultCount) {
        resultCount.textContent = (query || filter !== 'all')
            ? `عرض ${rows.length} من ${all.length}`
            : '';
    }

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="table-empty">مفيش نتايج مطابقة. جرّب كلمة تانية أو غيّر الفلتر.</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(m => {
        const id = esc(m.id);
        const isServant = m.role === 'servant';
        const roleBadge = isServant
            ? '<span class="role-badge servant">خادم</span>'
            : '<span class="role-badge member">مخدوم</span>';

        const genderText = m.gender === 'female' ? 'أنثى' : 'ذكر';
        const eduText = m.education === 'graduate' ? 'خريج' : 'طالب';
        const genderEduBadge = `<span class="muted" style="font-size: 0.85rem;">${genderText} / ${eduText}</span>`;

        const address = m.address ? esc(m.address) : '<span class="muted">--</span>';
        const phone = m.phone ? `<span dir="ltr">${esc(m.phone)}</span>` : '<span class="muted">--</span>';
        const birthdate = m.birthdate ? formatDate(m.birthdate) : '<span class="muted">--</span>';

        let ageText = '<span class="muted">--</span>';
        if (m.birthdate) {
            const bDate = new Date(m.birthdate);
            if (!isNaN(bDate)) {
                let age = new Date().getFullYear() - bDate.getFullYear();
                const mDiff = new Date().getMonth() - bDate.getMonth();
                if (mDiff < 0 || (mDiff === 0 && new Date().getDate() < bDate.getDate())) {
                    age--;
                }
                ageText = age + ' سنة';
            }
        }

        return `
            <tr>
                <td><button type="button" class="cell-name" data-action="profile" data-id="${id}">${esc(m.name)}</button></td>
                <td>${genderEduBadge}</td>
                <td>${address}</td>
                <td>${roleBadge}</td>
                <td>${phone}</td>
                <td>${birthdate}</td>
                <td>${ageText}</td>
                <td>
                    <div class="row-actions">
                        <button type="button" class="btn btn-outline btn-sm" data-action="profile" data-id="${id}"><i class="ph ph-user"></i> الملف</button>
                        <button type="button" class="btn btn-outline btn-sm" data-action="edit" data-id="${id}"><i class="ph ph-pencil-simple"></i> تعديل</button>
                        <button type="button" class="btn btn-danger-outline btn-sm" data-action="delete" data-id="${id}"><i class="ph ph-trash"></i> حذف</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    // Also populate Mobile Cards (Stitch _6)
    const mobileCardsContainer = document.getElementById('admin-cards-mobile');
    if (mobileCardsContainer) {
        mobileCardsContainer.innerHTML = rows.map(m => {
            const id = esc(m.id);
            const isServant = m.role === 'servant';
            const initial = (m.name || '').trim().charAt(0) || 'أ';
            const genderText = m.gender === 'female' ? 'أنثى' : 'ذكر';
            const eduText = m.education === 'graduate' ? 'خريج' : (m.education === 'student' ? 'طالب' : '--');

            let ageText = '-- سنة';
            if (m.birthdate) {
                const bDate = new Date(m.birthdate);
                if (!isNaN(bDate)) {
                    let age = new Date().getFullYear() - bDate.getFullYear();
                    const mDiff = new Date().getMonth() - bDate.getMonth();
                    if (mDiff < 0 || (mDiff === 0 && new Date().getDate() < bDate.getDate())) age--;
                    ageText = age + ' سنة';
                }
            }
            const subtitleText = `${genderText} / ${eduText} • ${ageText}`;
            const birthdateDisplay = m.birthdate ? formatDate(m.birthdate) : '--';

            return `
                <article class="admin-member-card ${isServant ? 'card-servant' : 'card-member'}">
                    <div class="admin-card-head">
                        <div class="admin-card-user-info">
                            <div class="admin-card-avatar ${isServant ? 'avatar-servant' : 'avatar-member'}">
                                ${esc(initial)}
                            </div>
                            <div>
                                <h3 class="admin-card-name">${esc(m.name)}</h3>
                                <p class="admin-card-subtitle">${subtitleText}</p>
                            </div>
                        </div>
                        <span class="admin-role-badge ${isServant ? 'badge-servant' : 'badge-member'}">
                            ${isServant ? 'خادم' : 'مخدوم'}
                        </span>
                    </div>
                    <div class="admin-card-info-grid">
                        <div class="info-cell">
                            <i class="ph ph-map-pin"></i>
                            <span class="truncate">${esc(m.address || 'بدون منطقة')}</span>
                        </div>
                        <div class="info-cell dir-ltr">
                            <i class="ph ph-phone"></i>
                            <span class="font-mono">${m.phone ? esc(m.phone) : 'لا يوجد رقم'}</span>
                        </div>
                        <div class="info-meta-row">
                            <span>تاريخ الميلاد: <strong>${birthdateDisplay}</strong></span>
                            <span>السن الحالي: <strong>${ageText}</strong></span>
                        </div>
                    </div>
                    <div class="admin-card-actions">
                        <button type="button" class="btn-card-action btn-card-profile" data-action="profile" data-id="${id}">
                            <i class="ph ph-user"></i> <span>الملف</span>
                        </button>
                        <button type="button" class="btn-card-action btn-card-edit" data-action="edit" data-id="${id}">
                            <i class="ph ph-pencil-simple"></i> <span>تعديل</span>
                        </button>
                        <button type="button" class="btn-card-action btn-card-delete" data-action="delete" data-id="${id}">
                            <i class="ph ph-trash"></i> <span>حذف</span>
                        </button>
                    </div>
                </article>
            `;
        }).join('');
    }
    if (typeof enforcePermissions === 'function') enforcePermissions();
};

function setupAdminTable(...args) {
    const res = setupAdminTable_original(...args);
    setTimeout(enforcePermissions, 50);
    return res;
}
function setupAdminTable_original() {
    const tbody = document.getElementById('admin-members-tbody');
    if (tbody) {
        tbody.addEventListener('click', (e) => {
            const el = e.target.closest('[data-action]');
            if (!el) return;
            const id = el.getAttribute('data-id');
            const action = el.getAttribute('data-action');
            if (action === 'profile') openMemberProfile(id);
            else if (action === 'edit') openPersonModal(id);
            else if (action === 'delete') deleteMemberFromAdmin(id);
        });
    }

    const mobileCards = document.getElementById('admin-cards-mobile');
    if (mobileCards) {
        mobileCards.addEventListener('click', (e) => {
            const el = e.target.closest('[data-action]');
            if (!el) return;
            const id = el.getAttribute('data-id');
            const action = el.getAttribute('data-action');
            if (action === 'profile') openMemberProfile(id);
            else if (action === 'edit') openPersonModal(id);
            else if (action === 'delete') deleteMemberFromAdmin(id);
        });
    }
}

function setSegmented(groupId, value) {
    document.querySelectorAll(`#${groupId} button`).forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-value') === value);
    });
}

function getSegmented(groupId) {
    const active = document.querySelector(`#${groupId} button.active`);
    return active ? active.getAttribute('data-value') : null;
}

window.openPersonModal = function (id) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('admin-edit')) {
        alert('عفواً، لا تملك صلاحية إضافة أو تعديل البيانات.');
        return;
    }
    const person = id ? getMembers().find(m => m.id === id) : null;
    if (id && !person) return;

    const activeFilter = document.querySelector('#admin-filters .filter-btn.active')?.getAttribute('data-filter');

    document.getElementById('person-id').value = person ? person.id : '';
    document.getElementById('person-modal-title-text').textContent = person ? 'تعديل بيانات' : 'إضافة شخص';
    document.getElementById('person-name').value = person ? person.name : '';
    document.getElementById('person-phone').value = person ? (person.phone || '') : '';
    document.getElementById('person-address').value = person ? (person.address || '') : '';
    document.getElementById('person-birthdate').value = person ? (person.birthdate || '') : '';
    setSegmented('person-role', person ? (person.role === 'servant' ? 'servant' : 'member') : (activeFilter === 'servant' ? 'servant' : 'member'));
    setSegmented('person-gender', person && person.gender === 'female' ? 'female' : 'male');
    setSegmented('person-education', person && person.education === 'graduate' ? 'graduate' : 'student');

    document.getElementById('person-modal-bg').classList.add('active');
    setTimeout(() => document.getElementById('person-name').focus(), 50);
};

function savePerson() {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('admin-edit')) {
        alert('عفواً، حسابك يملك صلاحية المشاهدة فقط ولا يمكنه إضافة أو تعديل الأعضاء.');
        return;
    }
    const id = document.getElementById('person-id').value;
    const nameInput = document.getElementById('person-name');
    const name = nameInput.value.trim();
    const phone = document.getElementById('person-phone').value.trim();
    const address = document.getElementById('person-address').value.trim();
    const birthdate = document.getElementById('person-birthdate').value;
    const role = getSegmented('person-role') || 'member';
    const gender = getSegmented('person-gender') || 'male';
    const education = getSegmented('person-education') || 'student';

    if (!name) {
        showToast('اكتب الاسم الأول', 'error');
        nameInput.focus();
        return;
    }
    if (phone && !/^[\d+\s-]{7,}$/.test(phone)) {
        showToast('رقم التليفون لازم يكون أرقام بس', 'error');
        document.getElementById('person-phone').focus();
        return;
    }

    const members = getMembers();
    const duplicate = members.find(m => m.id !== id && normalizeAr(m.name) === normalizeAr(name));
    if (duplicate && !confirm(`فيه شخص بنفس الاسم "${duplicate.name}" مسجل بالفعل. تكمل؟`)) return;

    if (id) {
        const idx = members.findIndex(m => m.id === id);
        if (idx === -1) return;
        members[idx] = { ...members[idx], name, phone, address, birthdate, role, gender, education };
    } else {
        members.push({
            id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
            name, phone, address, birthdate, role, gender, education,
            addedAt: todayLocal()
        });
    }
    saveMembers(members);

    document.getElementById('person-modal-bg').classList.remove('active');
    refreshAdminView();
    if (typeof refreshDashboard === 'function') refreshDashboard();
    if (typeof populateDeleteList === 'function') populateDeleteList();
    showToast(id ? 'تم حفظ التعديلات' : 'تمت الإضافة');
}

function setupPersonModal() {
    setupAdminTable();

    const btnAddPerson = document.getElementById('btn-add-person');
    if (btnAddPerson) btnAddPerson.addEventListener('click', () => openPersonModal(null));

    const btnSavePerson = document.getElementById('btn-save-person');
    if (btnSavePerson) btnSavePerson.addEventListener('click', savePerson);

    const btnCancelPerson = document.getElementById('btn-cancel-person');
    if (btnCancelPerson) btnCancelPerson.addEventListener('click', () => {
        document.getElementById('person-modal-bg').classList.remove('active');
    });

    ['person-role', 'person-gender', 'person-education'].forEach(groupId => {
        const el = document.getElementById(groupId);
        if (el) {
            el.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-value]');
                if (btn) setSegmented(groupId, btn.getAttribute('data-value'));
            });
        }
    });

    ['person-name', 'person-phone', 'person-address', 'person-birthdate'].forEach(inputId => {
        const el = document.getElementById(inputId);
        if (el) {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') savePerson();
            });
        }
    });
}

function setupModalDismiss() {
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('mousedown', (e) => {
            if (overlay.id === 'login-modal-bg') return; // NEVER dismiss login modal!
            if (e.target === overlay) overlay.classList.remove('active');
        });
        overlay.addEventListener('touchstart', (e) => {
            if (overlay.id === 'login-modal-bg') return; // NEVER dismiss login modal!
        }, { passive: true });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.active').forEach(o => {
                if (o.id === 'login-modal-bg') return; // NEVER dismiss login modal!
                o.classList.remove('active');
            });
        }
    });
}

window.editMemberFull = function (id) {
    openPersonModal(id);
};

window.deleteMemberFromAdmin = function (id) {
    if (!deletePerson(id)) return;
    refreshAdminView();
    if (typeof refreshDashboard === 'function') refreshDashboard();
    if (typeof populateDeleteList === 'function') populateDeleteList();
    showToast('تم الحذف');
};


// --- Servants Dashboard Logic ---
function refreshServantsDashboard() {
    const list = document.getElementById('servants-dashboard-list');
    list.innerHTML = '';

    const members = getMembers();
    const servants = members.filter(m => m.role === 'servant');

    if (servants.length === 0) {
        list.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px;">لا يوجد خدام مسجلين</td></tr>';
        return;
    }

    const records = getAttendanceRecords();
    const visitations = getVisitations();
    const servantRecords = getServantRecords();

    const totalMeetings = Object.keys(records).length;

    servants.forEach(servant => {
        let attendedCount = 0;
        let presentedCount = 0;
        let leaderCount = 0;
        let early = 0, middle = 0, late = 0;
        let visitsMade = 0;

        // Calculate Attendance and Servant Stats
        Object.keys(records).forEach(date => {
            if (records[date] && records[date].includes(servant.id)) {
                attendedCount++;
            }
            if (servantRecords[date] && servantRecords[date][servant.id]) {
                const sData = servantRecords[date][servant.id];
                if (sData.presented) presentedCount++;
                if (sData.leader) leaderCount++;
                if (sData.arrival === 'early') early++;
                else if (sData.arrival === 'middle') middle++;
                else if (sData.arrival === 'late') late++;
            }
        });

        // Calculate Visitations
        Object.values(visitations).forEach(mVisits => {
            if (!Array.isArray(mVisits)) return;
            mVisits.forEach(v => {
                if (Array.isArray(v.servants) && (v.servants.includes(servant.id) || v.servants.includes(servant.name))) {
                    visitsMade++;
                } else if (typeof v.servants === 'string' && (v.servants.includes(servant.id) || v.servants.includes(servant.name) || (servant.name.split(' ')[0] && v.servants.includes(servant.name.split(' ')[0])))) {
                    visitsMade++;
                }
            });
        });

        const attendanceRate = totalMeetings > 0 ? Math.round((attendedCount / totalMeetings) * 100) : 0;

        let arrivalHtml = '';
        if (early === 0 && middle === 0 && late === 0) {
            arrivalHtml = '<span style="color:var(--text-muted);">--</span>';
        } else {
            if (early > 0) arrivalHtml += `<span class="status-badge badge-success" style="font-size:0.7rem; margin-right:3px;">بدري: ${early}</span>`;
            if (middle > 0) arrivalHtml += `<span class="status-badge badge-warning" style="font-size:0.7rem; margin-right:3px;">في النص: ${middle}</span>`;
            if (late > 0) arrivalHtml += `<span class="status-badge badge-danger" style="font-size:0.7rem; margin-right:3px;">متأخر: ${late}</span>`;
        }

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--glass-border)';
        tr.innerHTML = `
            <td style="padding: 15px; font-weight: bold; cursor: pointer;" onclick="openMemberProfile('${servant.id}')">${servant.name}</td>
            <td style="padding: 15px; text-align: center;">${attendanceRate}%</td>
            <td style="padding: 15px; text-align: center; font-weight: bold;">${visitsMade}</td>
            <td style="padding: 15px; text-align: center;">${presentedCount}</td>
            <td style="padding: 15px; text-align: center;">${leaderCount}</td>
            <td style="padding: 15px; text-align: right;">${arrivalHtml}</td>
            <td style="padding: 15px; text-align: center;">
                <button class="btn btn-outline btn-sm" onclick="openServantReportModal('${servant.id}')" title="عرض ونسخ تقرير الخادم كرسالة">
                    <i class="ph ph-copy"></i> تقرير
                </button>
            </td>
        `;

        list.appendChild(tr);
    });
}

// ==========================================
// SERVANTS NOTES LOGIC (ملاحظات للخدام - خاص وسري)
// ==========================================

let currentNotesFilter = 'all';
let currentHistoryServantId = null;
let currentHistoryFilter = 'all';

function syncPastPresentationNotes() {
    try {
        const servantRecords = getServantRecords();
        const members = getMembers();
        let notes = getServantNotes();
        let changed = false;

        Object.keys(servantRecords).forEach(date => {
            const dayData = servantRecords[date] || {};
            Object.keys(dayData).forEach(servantId => {
                if (dayData[servantId] && dayData[servantId].presented) {
                    const autoNoteId = `sn_auto_pres_${servantId}_${date}`;
                    const exists = notes.some(n => n.id === autoNoteId);
                    if (!exists) {
                        const servant = members.find(m => m.id === servantId);
                        notes.push({
                            id: autoNoteId,
                            servantId: servantId,
                            servantName: servant ? servant.name : '',
                            type: 'positive',
                            category: 'تحضير وفقرات',
                            date: date,
                            text: `تقديم فقرة في اليوم بتاريخ ${formatDate(date)}`,
                            source: 'auto_presented',
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString()
                        });
                        changed = true;
                    }
                }
            });
        });

        if (changed) {
            saveServantNotes(notes);
        }
    } catch {}
}

function setupServantsNotes() {
    syncPastPresentationNotes();

    // Main add note button
    const btnAddMain = document.getElementById('btn-add-servant-note-main');
    if (btnAddMain) {
        btnAddMain.addEventListener('click', () => {
            openAddServantNoteModal();
        });
    }

    // 5. Note Type Toggles in Modal
    const btnTypePos = document.getElementById('btn-toggle-type-pos');
    const btnTypeNeg = document.getElementById('btn-toggle-type-neg');
    const noteTypeVal = document.getElementById('note-type-val');

    if (btnTypePos && btnTypeNeg && noteTypeVal) {
        btnTypePos.addEventListener('click', () => {
            noteTypeVal.value = 'positive';
            btnTypePos.classList.add('active');
            btnTypeNeg.classList.remove('active');
        });
        btnTypeNeg.addEventListener('click', () => {
            noteTypeVal.value = 'negative';
            btnTypeNeg.classList.add('active');
            btnTypePos.classList.remove('active');
        });
    }

    // 6. Save Note Button
    const btnSaveNote = document.getElementById('btn-save-servant-note');
    if (btnSaveNote) {
        btnSaveNote.addEventListener('click', saveServantNote);
    }

    // 7. Filters & Sort listeners
    const filterBtns = document.querySelectorAll('#servants-notes-filters [data-notes-filter]');
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentNotesFilter = btn.getAttribute('data-notes-filter');
            renderServantsNotesGrid();
        });
    });

    const sortSelect = document.getElementById('sort-servants-notes');
    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            renderServantsNotesGrid();
        });
    }

    const searchInput = document.getElementById('search-servants-notes');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            renderServantsNotesGrid();
        });
    }

    // 8. History Modal Filter Buttons & Quick Add
    ['all', 'pos', 'neg'].forEach(t => {
        const b = document.getElementById(`btn-hist-filter-${t}`);
        if (b) {
            b.addEventListener('click', () => {
                document.querySelectorAll('[data-hist-filter]').forEach(el => el.classList.remove('active'));
                b.classList.add('active');
                currentHistoryFilter = b.getAttribute('data-hist-filter');
                if (currentHistoryServantId) renderServantNotesHistory(currentHistoryServantId, currentHistoryFilter);
            });
        }
    });

    const btnHistoryQuickAdd = document.getElementById('btn-history-quick-add');
    if (btnHistoryQuickAdd) {
        btnHistoryQuickAdd.addEventListener('click', () => {
            if (currentHistoryServantId) {
                openAddServantNoteModal(currentHistoryServantId);
            }
        });
    }

    // 9. Export to Excel
    const btnExport = document.getElementById('btn-export-servant-notes');
    if (btnExport) {
        btnExport.addEventListener('click', exportServantNotesToExcel);
    }

    // 10. Servant Report Copy & Share Listeners
    const btnCopyReportText = document.getElementById('btn-copy-servant-report-text');
    if (btnCopyReportText) {
        btnCopyReportText.addEventListener('click', () => {
            const preview = document.getElementById('servant-report-preview');
            if (!preview || !preview.value) return;
            copyTextToClipboardHelper(preview.value, () => {
                showToast('تم نسخ تقرير الخدام للحافظة بنجاح! 📋 جاهز للمشاركة', 'success');
            });
        });
    }

    const btnShareWhatsapp = document.getElementById('btn-share-servant-report-whatsapp');
    if (btnShareWhatsapp) {
        btnShareWhatsapp.addEventListener('click', () => {
            const preview = document.getElementById('servant-report-preview');
            if (!preview || !preview.value) return;
            const waUrl = `https://wa.me/?text=${encodeURIComponent(preview.value)}`;
            window.open(waUrl, '_blank');
        });
    }
}

function refreshServantsNotes() {
    renderServantsNotesGrid();
}

function renderServantsNotesGrid() {

    const members = getMembers();
    const servants = members.filter(m => m.role === 'servant');
    const allNotes = getServantNotes();

    // Map notes by servantId
    const notesByServant = {};
    servants.forEach(s => { notesByServant[s.id] = []; });
    allNotes.forEach(n => {
        if (!notesByServant[n.servantId]) notesByServant[n.servantId] = [];
        notesByServant[n.servantId].push(n);
    });

    // Update Overall Stats
    const totalServants = servants.length;
    const totalNotesCount = allNotes.length;
    const posNotesCount = allNotes.filter(n => n.type === 'positive').length;
    const negNotesCount = allNotes.filter(n => n.type === 'negative').length;
    const posPct = totalNotesCount > 0 ? Math.round((posNotesCount / totalNotesCount) * 100) : 0;

    const elTotalServants = document.getElementById('notes-stat-servants-count');
    const elTotalNotes = document.getElementById('notes-stat-total-notes');
    const elPosNotes = document.getElementById('notes-stat-positive-notes');
    const elNegNotes = document.getElementById('notes-stat-negative-notes');
    const elPosPct = document.getElementById('notes-stat-pos-percent');

    if (elTotalServants) elTotalServants.innerText = totalServants;
    if (elTotalNotes) elTotalNotes.innerText = totalNotesCount;
    if (elPosNotes) elPosNotes.innerText = posNotesCount;
    if (elNegNotes) elNegNotes.innerText = negNotesCount;
    if (elPosPct) elPosPct.innerText = `${posPct}% من الإجمالي`;

    // Calculate Counts for Filter Badges
    let countAll = servants.length;
    let countHas = 0;
    let countPos = 0;
    let countNeg = 0;
    let countNone = 0;

    servants.forEach(s => {
        const sNotes = notesByServant[s.id] || [];
        if (sNotes.length > 0) countHas++;
        else countNone++;
        if (sNotes.some(n => n.type === 'positive')) countPos++;
        if (sNotes.some(n => n.type === 'negative')) countNeg++;
    });

    const setBadge = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
    setBadge('count-notes-all', countAll);
    setBadge('count-notes-has', countHas);
    setBadge('count-notes-pos', countPos);
    setBadge('count-notes-neg', countNeg);
    setBadge('count-notes-none', countNone);

    // Filter & Search
    const searchVal = normalizeAr(document.getElementById('search-servants-notes')?.value || '');
    const sortVal = document.getElementById('sort-servants-notes')?.value || 'recent';

    let filtered = servants.filter(s => {
        const sNotes = notesByServant[s.id] || [];
        
        // Filter by tab
        if (currentNotesFilter === 'has-notes' && sNotes.length === 0) return false;
        if (currentNotesFilter === 'has-pos' && !sNotes.some(n => n.type === 'positive')) return false;
        if (currentNotesFilter === 'has-neg' && !sNotes.some(n => n.type === 'negative')) return false;
        if (currentNotesFilter === 'no-notes' && sNotes.length > 0) return false;

        // Search in servant name, address, phone or notes text
        if (searchVal) {
            const nameMatch = normalizeAr(s.name).includes(searchVal);
            const phoneMatch = (s.phone || '').includes(searchVal);
            const notesMatch = sNotes.some(n => normalizeAr(n.text || '').includes(searchVal) || normalizeAr(n.category || '').includes(searchVal));
            if (!nameMatch && !phoneMatch && !notesMatch) return false;
        }

        return true;
    });

    // Sorting
    filtered.sort((a, b) => {
        const aNotes = notesByServant[a.id] || [];
        const bNotes = notesByServant[b.id] || [];

        if (sortVal === 'alpha') {
            return a.name.localeCompare(b.name, 'ar');
        } else if (sortVal === 'most-notes') {
            return bNotes.length - aNotes.length;
        } else if (sortVal === 'most-neg') {
            const aNeg = aNotes.filter(n => n.type === 'negative').length;
            const bNeg = bNotes.filter(n => n.type === 'negative').length;
            return bNeg - aNeg;
        } else if (sortVal === 'most-pos') {
            const aPos = aNotes.filter(n => n.type === 'positive').length;
            const bPos = bNotes.filter(n => n.type === 'positive').length;
            return bPos - aPos;
        } else {
            // 'recent' by latest note timestamp
            const aLatest = aNotes.length > 0 ? Math.max(...aNotes.map(n => new Date(n.updatedAt || n.createdAt || n.date).getTime())) : 0;
            const bLatest = bNotes.length > 0 ? Math.max(...bNotes.map(n => new Date(n.updatedAt || n.createdAt || n.date).getTime())) : 0;
            if (bLatest !== aLatest) return bLatest - aLatest;
            return a.name.localeCompare(b.name, 'ar');
        }
    });

    // Render Grid
    const grid = document.getElementById('servants-notes-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (filtered.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 50px 20px; color: var(--text-muted);" class="glass">
                <i class="ph ph-folder-open" style="font-size: 3rem; margin-bottom: 15px; opacity: 0.6;"></i>
                <h3>لا توجد نتائج تطابق البحث أو الفلتر</h3>
                <p style="margin-top: 5px;">جرب تغيير كلمة البحث أو اختيار فلتر آخر.</p>
            </div>
        `;
        return;
    }

    filtered.forEach(servant => {
        const sNotes = (notesByServant[servant.id] || []).sort((x, y) => new Date(y.date || y.createdAt) - new Date(x.date || x.createdAt));
        const posCount = sNotes.filter(n => n.type === 'positive').length;
        const negCount = sNotes.filter(n => n.type === 'negative').length;
        const total = sNotes.length;

        const posWidth = total > 0 ? (posCount / total) * 100 : 50;
        const negWidth = total > 0 ? (negCount / total) * 100 : 50;

        const latestNote = sNotes[0];

        const card = document.createElement('div');
        card.className = 'servant-note-card glass';

        let recentSnippetHtml = '';
        if (latestNote) {
            const isPos = latestNote.type === 'positive';
            recentSnippetHtml = `
                <div class="servant-note-recent ${isPos ? 'pos' : 'neg'}">
                    <div class="servant-note-recent-header">
                        <span>${isPos ? '🟢 إيجابية' : '🔴 سلبية'} • ${esc(latestNote.category || 'عام')}</span>
                        <span>${formatDate(latestNote.date)}</span>
                    </div>
                    <div class="servant-note-recent-text">"${esc(latestNote.text)}"</div>
                </div>
            `;
        } else {
            recentSnippetHtml = `
                <div class="servant-note-recent" style="border-right-color: var(--glass-border); opacity: 0.65; text-align: center; font-style: italic;">
                    لا توجد ملاحظات مسجلة بعد لهذا الخادم
                </div>
            `;
        }

        const canEditNotes = currentUserRole === 'admin' || currentPermissions.includes('servants-notes-edit');
        const addNoteBtnHtml = canEditNotes ? `
            <button class="btn btn-primary btn-sm" onclick="openAddServantNoteModal('${servant.id}')">
                <i class="ph ph-plus"></i> إضافة ملاحظة
            </button>
        ` : '';

        card.innerHTML = `
            <div>
                <div class="servant-note-card-header">
                    <div class="servant-note-avatar">
                        <i class="ph ${servant.gender === 'female' ? 'ph-user' : 'ph-user-gear'}"></i>
                    </div>
                    <div class="servant-note-info">
                        <h3 title="${esc(servant.name)}">${esc(servant.name)}</h3>
                        <div class="servant-sub">${esc(servant.phone || servant.address || 'خادم بالاجتماع')}</div>
                    </div>
                </div>

                <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px;">
                    <span class="badge-note-pos">🟢 ${posCount} إيجابية</span>
                    <span class="badge-note-neg">🔴 ${negCount} سلبية</span>
                    <span style="font-size: 0.8rem; color: var(--text-muted); align-self: center; margin-right: auto;">إجمالي: ${total}</span>
                </div>

                <div class="servant-note-ratio-bar">
                    ${total > 0 ? `
                        <div class="servant-note-ratio-pos" style="width: ${posWidth}%;"></div>
                        <div class="servant-note-ratio-neg" style="width: ${negWidth}%;"></div>
                    ` : `
                        <div style="width: 100%; background: rgba(255,255,255,0.06);"></div>
                    `}
                </div>

                ${recentSnippetHtml}
            </div>

            <div class="servant-note-actions">
                ${addNoteBtnHtml}
                <button class="btn btn-outline btn-sm" onclick="openServantNotesHistoryModal('${servant.id}')">
                    <i class="ph ph-notebook"></i> السجل (${total})
                </button>
                <button class="btn btn-outline btn-sm" onclick="openServantReportModal('${servant.id}')" title="عرض ونسخ تقرير الخادم كرسالة">
                    <i class="ph ph-copy"></i> نسخ التقرير
                </button>
            </div>
        `;

        grid.appendChild(card);
    });
}

window.openAddServantNoteModal = function(servantId = null, editNoteId = null) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('servants-notes-edit')) {
        alert('عفواً، لا تملك صلاحية إضافة أو تعديل ملاحظات الخدام (المشاهدة فقط).');
        return;
    }
    const modal = document.getElementById('servant-note-modal-bg');
    if (!modal) return;

    const servants = getMembers().filter(m => m.role === 'servant').sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    const select = document.getElementById('note-servant-select');
    select.innerHTML = '';

    servants.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.innerText = s.name;
        select.appendChild(opt);
    });

    const editIdInput = document.getElementById('edit-note-id');
    const titleEl = document.getElementById('servant-note-modal-title');
    const typeValInput = document.getElementById('note-type-val');
    const btnPos = document.getElementById('btn-toggle-type-pos');
    const btnNeg = document.getElementById('btn-toggle-type-neg');
    const catSelect = document.getElementById('note-category-select');
    const dateInput = document.getElementById('note-date-input');
    const textInput = document.getElementById('note-text-input');

    if (editNoteId) {
        const allNotes = getServantNotes();
        const existing = allNotes.find(n => n.id === editNoteId);
        if (existing) {
            editIdInput.value = existing.id;
            titleEl.innerHTML = `<i class="ph ph-note-pencil"></i> تعديل الملاحظة`;
            select.value = existing.servantId;
            typeValInput.value = existing.type || 'positive';
            if (existing.type === 'negative') {
                btnNeg.classList.add('active');
                btnPos.classList.remove('active');
            } else {
                btnPos.classList.add('active');
                btnNeg.classList.remove('active');
            }
            catSelect.value = existing.category || 'عام';
            dateInput.value = existing.date || todayLocal();
            textInput.value = existing.text || '';
        }
    } else {
        editIdInput.value = '';
        titleEl.innerHTML = `<i class="ph ph-note-pencil"></i> إضافة ملاحظة لخادم`;
        if (servantId) select.value = servantId;
        typeValInput.value = 'positive';
        btnPos.classList.add('active');
        btnNeg.classList.remove('active');
        catSelect.value = 'عام';
        dateInput.value = todayLocal();
        textInput.value = '';
    }

    modal.classList.add('active');
    setTimeout(() => { if (textInput) textInput.focus(); }, 150);
};

function saveServantNote() {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('servants-notes-edit')) {
        alert('عفواً، لا تملك صلاحية إضافة أو تعديل ملاحظات الخدام (المشاهدة فقط).');
        return;
    }
    const editId = (document.getElementById('edit-note-id')?.value || '').trim();
    const servantId = document.getElementById('note-servant-select')?.value;
    const type = document.getElementById('note-type-val')?.value || 'positive';
    const category = document.getElementById('note-category-select')?.value || 'عام';
    const date = document.getElementById('note-date-input')?.value || todayLocal();
    const text = (document.getElementById('note-text-input')?.value || '').trim();

    if (!servantId) {
        alert('برجاء اختيار الخادم');
        return;
    }
    if (!text) {
        alert('برجاء كتابة نص الملاحظة');
        return;
    }

    const members = getMembers();
    const servant = members.find(m => m.id === servantId);
    const servantName = servant ? servant.name : '';

    let notes = getServantNotes();

    if (editId) {
        const idx = notes.findIndex(n => n.id === editId);
        if (idx !== -1) {
            notes[idx] = {
                ...notes[idx],
                servantId,
                servantName,
                type,
                category,
                date,
                text,
                updatedAt: new Date().toISOString()
            };
        }
    } else {
        const newNote = {
            id: 'sn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            servantId,
            servantName,
            type,
            category,
            date,
            text,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        notes.unshift(newNote);
    }

    saveServantNotes(notes);
    document.getElementById('servant-note-modal-bg').classList.remove('active');
    showToast('تم حفظ الملاحظة بنجاح ✅', 'success');

    renderServantsNotesGrid();
    if (currentHistoryServantId && document.getElementById('servant-notes-history-modal-bg').classList.contains('active')) {
        renderServantNotesHistory(currentHistoryServantId, currentHistoryFilter);
    }
}

window.openServantNotesHistoryModal = function(servantId) {
    currentHistoryServantId = servantId;
    currentHistoryFilter = 'all';

    // Reset filter active state in modal
    document.querySelectorAll('[data-hist-filter]').forEach(b => b.classList.remove('active'));
    document.getElementById('btn-hist-filter-all')?.classList.add('active');

    renderServantNotesHistory(servantId, 'all');
    document.getElementById('servant-notes-history-modal-bg').classList.add('active');
};

function renderServantNotesHistory(servantId, filterType = 'all') {
    const members = getMembers();
    const servant = members.find(m => m.id === servantId);
    const servantName = servant ? servant.name : 'الخادم';

    document.getElementById('history-modal-servant-title').innerHTML = `<i class="ph ph-user-circle"></i> سجل ملاحظات: ${esc(servantName)}`;

    const allNotes = getServantNotes();
    const sNotes = allNotes.filter(n => n.servantId === servantId).sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));

    const total = sNotes.length;
    const posCount = sNotes.filter(n => n.type === 'positive').length;
    const negCount = sNotes.filter(n => n.type === 'negative').length;

    document.getElementById('history-stat-total').innerText = total;
    document.getElementById('history-stat-pos').innerText = posCount;
    document.getElementById('history-stat-neg').innerText = negCount;

    let filtered = sNotes;
    if (filterType === 'positive') filtered = sNotes.filter(n => n.type === 'positive');
    if (filterType === 'negative') filtered = sNotes.filter(n => n.type === 'negative');

    const list = document.getElementById('servant-notes-history-list');
    list.innerHTML = '';

    if (filtered.length === 0) {
        list.innerHTML = `
            <div style="text-align: center; padding: 40px 15px; color: var(--text-muted);">
                <i class="ph ph-note-blank" style="font-size: 2.5rem; opacity: 0.5; margin-bottom: 10px;"></i>
                <p>لا توجد ملاحظات مسجلة تطابق الفلتر المحدد.</p>
            </div>
        `;
        return;
    }

    filtered.forEach(note => {
        const isPos = note.type === 'positive';
        const item = document.createElement('div');
        item.className = `note-history-item glass ${isPos ? 'pos' : 'neg'}`;

        item.innerHTML = `
            <div class="note-history-item-header">
                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                    <span class="${isPos ? 'badge-note-pos' : 'badge-note-neg'}">
                        ${isPos ? '<i class="ph ph-thumbs-up"></i> إيجابية' : '<i class="ph ph-thumbs-down"></i> سلبية'}
                    </span>
                    <span style="font-size: 0.8rem; background: rgba(255,255,255,0.08); padding: 3px 8px; border-radius: 8px; color: var(--text-muted);">
                        ${esc(note.category || 'عام')}
                    </span>
                    <span style="font-size: 0.8rem; color: var(--text-muted);"><i class="ph ph-calendar"></i> ${formatDate(note.date)}</span>
                </div>
                ${(currentUserRole === 'admin' || currentPermissions.includes('servants-notes-edit')) ? `
                <div style="display: flex; gap: 6px;">
                    <button class="btn btn-outline btn-sm" style="padding: 4px 8px; font-size: 0.8rem;" onclick="openAddServantNoteModal('${servantId}', '${note.id}')" title="تعديل الملاحظة">
                        <i class="ph ph-pencil-simple"></i>
                    </button>
                    <button class="btn btn-outline btn-sm" style="padding: 4px 8px; font-size: 0.8rem; border-color: var(--danger); color: var(--danger);" onclick="deleteServantNote('${note.id}')" title="حذف الملاحظة">
                        <i class="ph ph-trash"></i>
                    </button>
                </div>
                ` : ''}
            </div>
            <div class="note-history-item-content">${esc(note.text)}</div>
        `;

        list.appendChild(item);
    });
}

window.deleteServantNote = async function(noteId) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('servants-notes-edit')) {
        alert('عفواً، لا تملك صلاحية حذف ملاحظات الخدام (المشاهدة فقط).');
        return;
    }
    const ok = await customConfirm('هل أنت متأكد من حذف هذه الملاحظة نهائياً؟');
    if (!ok) return;

    let notes = getServantNotes();
    notes = notes.filter(n => n.id !== noteId);
    saveServantNotes(notes);

    showToast('تم حذف الملاحظة بنجاح 🗑️', 'warning');
    renderServantsNotesGrid();
    if (currentHistoryServantId) {
        renderServantNotesHistory(currentHistoryServantId, currentHistoryFilter);
    }
};

function exportServantNotesToExcel() {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('reports-view')) {
        alert('عفواً، لا تملك صلاحية استخراج تقارير الإكسيل.');
        return;
    }
    if (typeof XLSX === 'undefined') {
        alert('مكتبة تصدير الإكسيل غير متوفرة');
        return;
    }

    const members = getMembers();
    const membersMap = {};
    members.forEach(m => { membersMap[m.id] = m.name; });

    const notes = getServantNotes();
    if (notes.length === 0) {
        alert('لا توجد ملاحظات لتصديرها');
        return;
    }

    const rows = notes.map((n, idx) => ({
        "م": idx + 1,
        "اسم الخادم": membersMap[n.servantId] || n.servantName || 'غير معروف',
        "نوع الملاحظة": n.type === 'positive' ? 'إيجابية 🟢' : 'سلبية 🔴',
        "التصنيف": n.category || 'عام',
        "التاريخ": formatDate(n.date),
        "نص الملاحظة": n.text,
        "تاريخ الإضافة": n.createdAt ? n.createdAt.split('T')[0] : ''
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "ملاحظات الخدام");
    XLSX.writeFile(wb, `ملاحظات_خدام_الاجتماع_${todayLocal()}.xlsx`);
    showToast('تم تصدير ملف الإكسيل بنجاح 📊', 'success');
}

// ==========================================
// SERVANT REPORT COPY GENERATOR (تقرير الخدام - رسالة كوبي)
// ==========================================

function getServantFullStats(servantId) {
    const members = getMembers();
    const servant = members.find(m => m.id === servantId);
    if (!servant) return null;

    const records = getAttendanceRecords();
    const servantRecords = getServantRecords();
    const visitations = getVisitations();
    const allNotes = getServantNotes();

    const totalMeetings = Object.keys(records).length;
    let attendedCount = 0;
    let presentedCount = 0;
    let leaderCount = 0;
    let early = 0, middle = 0, late = 0;

    Object.keys(records).forEach(date => {
        if (records[date] && records[date].includes(servant.id)) {
            attendedCount++;
        }
        if (servantRecords[date] && servantRecords[date][servant.id]) {
            const sData = servantRecords[date][servant.id];
            if (sData.presented) presentedCount++;
            if (sData.leader) leaderCount++;
            if (sData.arrival === 'early') early++;
            else if (sData.arrival === 'middle') middle++;
            else if (sData.arrival === 'late') late++;
        }
    });

    const attendanceRate = totalMeetings > 0 ? Math.round((attendedCount / totalMeetings) * 100) : 0;

    // Visitations
    let totalVisitsMade = 0;
    const visitedMemberIds = new Set();
    const visitedMemberNames = [];

    const memberMap = {};
    members.forEach(m => { memberMap[m.id] = m.name; });

    Object.entries(visitations).forEach(([memberId, mVisits]) => {
        if (!Array.isArray(mVisits)) return;
        mVisits.forEach(v => {
            let matches = false;
            if (Array.isArray(v.servants)) {
                if (v.servants.includes(servant.id) || v.servants.includes(servant.name)) matches = true;
            } else if (typeof v.servants === 'string') {
                if (v.servants.includes(servant.id) || v.servants.includes(servant.name) || (servant.name.split(' ')[0] && v.servants.includes(servant.name.split(' ')[0]))) {
                    matches = true;
                }
            }

            if (matches) {
                totalVisitsMade++;
                if (!visitedMemberIds.has(memberId)) {
                    visitedMemberIds.add(memberId);
                    const mName = memberMap[memberId] || `عضو (${memberId})`;
                    visitedMemberNames.push(mName);
                }
            }
        });
    });

    // Notes
    const sNotes = allNotes.filter(n => n.servantId === servant.id)
                           .sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));
    const posNotes = sNotes.filter(n => n.type === 'positive');
    const negNotes = sNotes.filter(n => n.type === 'negative');

    return {
        servant,
        totalMeetings,
        attendedCount,
        attendanceRate,
        presentedCount,
        leaderCount,
        early,
        middle,
        late,
        totalVisitsMade,
        uniqueVisitedCount: visitedMemberIds.size,
        visitedMemberNames,
        posNotes,
        negNotes,
        totalNotes: sNotes.length
    };
}

function formatSingleServantReport(stats) {
    if (!stats) return '';
    const { servant, totalMeetings, attendedCount, attendanceRate, presentedCount, leaderCount, early, middle, late, totalVisitsMade, uniqueVisitedCount, visitedMemberNames, posNotes, negNotes, totalNotes } = stats;

    const todayStr = new Date().toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' });

    let msg = `📊 *تقرير أداء ومتابعة خادم* 📊\n`;
    msg += `*اجتماع القديس يوحنا الحبيب*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `👤 *الخادم:* ${servant.name}\n`;
    if (servant.phone) msg += `📱 *الهاتف:* ${servant.phone}\n`;
    if (servant.address) msg += `📍 *المنطقة:* ${servant.address}\n`;
    msg += `\n`;

    msg += `📈 *إحصائيات الحضور والخدمة:*\n`;
    msg += `▫️ *نسبة الحضور:* ${attendanceRate}% (${attendedCount} من إجمالي ${totalMeetings} اجتماع)\n`;
    if (early > 0 || middle > 0 || late > 0) {
        msg += `▫️ *تحليل المواعيد:* ${early} بدري | ${middle} في الميعاد | ${late} متأخر\n`;
    }
    msg += `▫️ *عدد الفقرات المقدمة:* ${presentedCount} فقرة\n`;
    if (leaderCount > 0) {
        msg += `▫️ *مسؤول اليوم (قيادة):* ${leaderCount} مرة\n`;
    }
    msg += `\n`;

    msg += `🚗 *نشاط الافتقاد:*\n`;
    if (uniqueVisitedCount > 0) {
        msg += `▫️ *نزل افتقاد لـ:* ${uniqueVisitedCount} مخدوم (إجمالي ${totalVisitsMade} نزول افتقاد)\n`;
        const previewNames = visitedMemberNames.slice(0, 15).join('، ');
        const moreSuffix = visitedMemberNames.length > 15 ? ` و${visitedMemberNames.length - 15} آخرين` : '';
        msg += `▫️ *المخدومين:* ${previewNames}${moreSuffix}\n`;
    } else {
        msg += `▫️ لم يتم تسجيل نزول افتقاد حتى الآن.\n`;
    }
    msg += `\n`;

    msg += `📝 *سجل التقييم والملاحظات (${totalNotes}):*\n`;
    msg += `▫️ 🟢 إيجابيات: ${posNotes.length} | 🔴 سلبيات: ${negNotes.length}\n\n`;

    msg += `🟢 *الإيجابيات (${posNotes.length}):*\n`;
    if (posNotes.length > 0) {
        posNotes.forEach((n, idx) => {
            const cat = n.category ? `(${n.category})` : '';
            const d = n.date ? `[${formatDate(n.date)}] ` : '';
            msg += `${idx + 1}. ${d}${cat} ${n.text}\n`;
        });
    } else {
        msg += `▫️ لا توجد ملاحظات إيجابية مسجلة حالياً.\n`;
    }
    msg += `\n`;

    msg += `🔴 *الملاحظات والسلبيات (${negNotes.length}):*\n`;
    if (negNotes.length > 0) {
        negNotes.forEach((n, idx) => {
            const cat = n.category ? `(${n.category})` : '';
            const d = n.date ? `[${formatDate(n.date)}] ` : '';
            msg += `${idx + 1}. ${d}${cat} ${n.text}\n`;
        });
    } else {
        msg += `▫️ لا توجد سلبيات مسجلة (خدمة متميزة ✨)\n`;
    }

    msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📅 *تاريخ التقرير:* ${todayStr}\n`;

    return msg;
}

function formatAllServantsReport() {
    const members = getMembers();
    const servants = members.filter(m => m.role === 'servant').sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    const todayStr = new Date().toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' });
    const records = getAttendanceRecords();
    const totalMeetings = Object.keys(records).length;

    let msg = `📊 *التقرير الشامل لمتابعة وتقييم الخدام* 📊\n`;
    msg += `*اجتماع القديس يوحنا الحبيب*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `👥 *إجمالي عدد الخدام:* ${servants.length} خادم\n`;
    msg += `📅 *إجمالي الاجتماعات:* ${totalMeetings} اجتماع\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    servants.forEach((servant, idx) => {
        const stats = getServantFullStats(servant.id);
        if (!stats) return;

        msg += `${idx + 1}️⃣ *${servant.name}*\n`;
        msg += `▫️ نسبة الحضور: ${stats.attendanceRate}% (${stats.attendedCount}/${totalMeetings})\n`;
        if (stats.early > 0 || stats.middle > 0 || stats.late > 0) {
            msg += `▫️ المواعيد: ${stats.early} بدري | ${stats.middle} في النص | ${stats.late} متأخر\n`;
        }
        msg += `▫️ عدد الفقرات: ${stats.presentedCount} فقرة | قيادة: ${stats.leaderCount}\n`;
        msg += `▫️ الافتقاد: نزل لـ ${stats.uniqueVisitedCount} مخدوم (${stats.totalVisitsMade} نزول)\n`;
        msg += `▫️ التقييم: 🟢 ${stats.posNotes.length} إيجابية | 🔴 ${stats.negNotes.length} سلبية\n`;

        if (stats.posNotes.length > 0) {
            const posSample = stats.posNotes.slice(0, 3).map(n => n.text).join(' • ');
            msg += `   🟢 إيجابيات: ${posSample}\n`;
        }
        if (stats.negNotes.length > 0) {
            const negSample = stats.negNotes.slice(0, 3).map(n => n.text).join(' • ');
            msg += `   🔴 سلبيات: ${negSample}\n`;
        }

        msg += `────────────────────\n`;
    });

    msg += `\n📅 *تاريخ التقرير:* ${todayStr}\n`;
    return msg;
}

window.openServantReportModal = function(targetServantId = 'all') {
    const modal = document.getElementById('servant-report-modal-bg');
    if (!modal) return;

    const select = document.getElementById('servant-report-select');
    const preview = document.getElementById('servant-report-preview');

    const members = getMembers();
    const servants = members.filter(m => m.role === 'servant').sort((a, b) => a.name.localeCompare(b.name, 'ar'));

    if (select) {
        select.innerHTML = `<option value="all">📊 تقرير شامل مجمع لكل الخدام (${servants.length} خادم)</option>`;
        servants.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.innerText = `👤 ${s.name}`;
            select.appendChild(opt);
        });

        // Set requested servant or 'all'
        if (targetServantId && (targetServantId === 'all' || servants.some(s => s.id === targetServantId))) {
            select.value = targetServantId;
        } else {
            select.value = 'all';
        }
    }

    const updatePreview = () => {
        const val = select ? select.value : 'all';
        if (val === 'all') {
            preview.value = formatAllServantsReport();
        } else {
            const stats = getServantFullStats(val);
            preview.value = formatSingleServantReport(stats);
        }
    };

    updatePreview();

    if (select && !select._hasReportListener) {
        select.addEventListener('change', updatePreview);
        select._hasReportListener = true;
    }

    modal.classList.add('active');
};

window.copyServantReportDirect = function(servantId, event) {
    if (event) event.stopPropagation();
    let text = '';
    let servantName = '';
    if (!servantId || servantId === 'all') {
        text = formatAllServantsReport();
        servantName = 'جميع الخدام';
    } else {
        const stats = getServantFullStats(servantId);
        if (!stats) return;
        text = formatSingleServantReport(stats);
        servantName = stats.servant.name;
    }

    copyTextToClipboardHelper(text, () => {
        showToast(`تم نسخ تقرير (${servantName}) كرسالة بنجاح! 📋`, 'success');
    });
};

function copyTextToClipboardHelper(text, callback) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            if (callback) callback();
        }).catch(() => {
            fallbackCopy(text, callback);
        });
    } else {
        fallbackCopy(text, callback);
    }
}

function fallbackCopy(text, callback) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
        document.execCommand('copy');
        if (callback) callback();
    } catch (e) {
        alert('يرجى تحديد النص ونسخه يدوياً');
    }
    document.body.removeChild(textarea);
}


// --- Dashboard Logic ---
function refreshDashboard() {
    const members = getMembers();
    const records = getAttendanceRecords();
    const dates = Object.keys(records).sort(); // Sort chronological
    const dayTypes = getDayTypes();

    // Total members
    document.getElementById('dash-total-members').innerText = members.length;

    // Highest & Average
    let highestMonth = 0;
    let highestMonthDate = '--';
    let currentMonthCount = 0;
    let currentMonthMeetings = 0;
    let prevMonthCount = 0;
    let prevMonthMeetings = 0;

    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    const prevMonthDate = new Date(currentYear, currentMonth - 1, 1);
    const prevMonth = prevMonthDate.getMonth();
    const prevYear = prevMonthDate.getFullYear();

    const chartLabels = [];
    const chartData = [];

    dates.forEach(date => {
        const type = dayTypes[date] || 'normal';
        if (type === 'holiday') return; // Skip holiday from charts and averages

        const attendees = records[date] || [];
        const count = attendees.length;

        // For chart and prediction
        chartLabels.push(date);
        chartData.push(count);

        const d = new Date(date);
        if (d.getMonth() === currentMonth && d.getFullYear() === currentYear) {
            currentMonthCount += count;
            currentMonthMeetings++;
            if (count > highestMonth) {
                highestMonth = count;
                highestMonthDate = date;
            }
        } else if (d.getMonth() === prevMonth && d.getFullYear() === prevYear) {
            prevMonthCount += count;
            prevMonthMeetings++;
        }
    });

    document.getElementById('dash-highest-attendance').innerText = highestMonth;
    const highestDateEl = document.getElementById('dash-highest-date');
    if (highestDateEl) {
        highestDateEl.innerText = highestMonthDate !== '--' ? `تاريخ: ${formatDate(highestMonthDate)}` : 'لا يوجد سجلات بالشهر';
    }

    const avg = currentMonthMeetings > 0 ? (currentMonthCount / currentMonthMeetings) : 0;
    const prevAvg = prevMonthMeetings > 0 ? (prevMonthCount / prevMonthMeetings) : 0;
    const percentage = members.length > 0 ? Math.round((avg / members.length) * 100) : 0;
    
    const avgPercentEl = document.getElementById('dash-avg-percent');
    const avgCountEl = document.getElementById('dash-avg-count');
    const avgOldEl = document.getElementById('dash-avg-attendance');
    if (avgPercentEl) avgPercentEl.innerText = `${percentage}%`;
    if (avgCountEl) avgCountEl.innerText = `(${Math.round(avg)} شخص)`;
    if (avgOldEl) avgOldEl.innerText = `${percentage}% (${Math.round(avg)} شخص)`;

    const diff = Math.round(avg - prevAvg);
    const compareEl = document.getElementById('dash-month-compare');
    if (compareEl) {
        if (prevMonthMeetings === 0) {
            compareEl.innerHTML = '-- مفيش بيانات للشهر الفائت';
            compareEl.className = 'stat-subtext';
        } else {
            if (diff > 0) {
                compareEl.innerHTML = `<i class="ph ph-trend-up"></i> +${diff} أشخاص عن الشهر الفائت`;
                compareEl.className = 'stat-subtext text-emerald';
            } else if (diff < 0) {
                compareEl.innerHTML = `<i class="ph ph-trend-down"></i> -${Math.abs(diff)} أشخاص عن الشهر الفائت`;
                compareEl.className = 'stat-subtext text-danger';
            } else {
                compareEl.innerHTML = `مماثل للشهر الفائت`;
                compareEl.className = 'stat-subtext';
            }
        }
    }

    const last4 = chartData.slice(-4);
    const predictionCount = last4.length > 0 ? Math.round(last4.reduce((a, b) => a + b, 0) / last4.length) : 0;
    const dashPred = document.getElementById('dash-prediction');
    if (dashPred) dashPred.innerText = predictionCount;

    // Areas Map
    const areasStats = {};
    members.forEach(m => {
        if (m.role === 'servant') return;
        const area = m.address && m.address.trim() !== '' ? m.address.trim() : 'بدون منطقة';
        if (!areasStats[area]) areasStats[area] = { total: 0, attendance: 0 };
        areasStats[area].total++;
    });

    dates.forEach(date => {
        const d = new Date(date);
        if (d.getMonth() === currentMonth && d.getFullYear() === currentYear && (dayTypes[date] || 'normal') !== 'holiday') {
            const attendees = records[date] || [];
            attendees.forEach(id => {
                const m = members.find(x => x.id === id);
                if (m && m.role !== 'servant') {
                    const area = m.address && m.address.trim() !== '' ? m.address.trim() : 'بدون منطقة';
                    if (areasStats[area]) areasStats[area].attendance++;
                }
            });
        }
    });

    const areasGrid = document.getElementById('dash-areas-grid');
    if (areasGrid) {
        areasGrid.innerHTML = '';
        Object.keys(areasStats).sort((a, b) => areasStats[b].total - areasStats[a].total).forEach(area => {
            const stat = areasStats[area];
            const possibleAttendances = stat.total * currentMonthMeetings;
            const pct = possibleAttendances > 0 ? Math.round((stat.attendance / possibleAttendances) * 100) : 0;
            let pctColor = 'var(--text-color)';
            if (pct < 30) pctColor = 'var(--danger)';
            else if (pct < 60) pctColor = 'var(--warning)';
            else if (pct > 0) pctColor = 'var(--success)';

            const countTag = document.getElementById('dash-areas-count-tag');
            if (countTag) countTag.textContent = `${Object.keys(areasStats).length} مناطق`;

            areasGrid.innerHTML += `
                <div class="dash-area-card">
                    <div class="area-name">${esc(area)}</div>
                    <div class="area-count"><strong>${stat.total}</strong> مخدوم</div>
                    <div class="area-pct-pill ${pct >= 50 ? 'pill-good' : (pct >= 25 ? 'pill-mid' : 'pill-low')}">${pct}% حضور</div>
                </div>
            `;
        });
    }

    // Calculate Birthdays (7 days ago + current month + 7 days ahead)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const seenIds = new Set();
    let upcomingBirthdays = [];

    members.forEach(m => {
        if (!m.birthdate || seenIds.has(m.id)) return;
        const [bYear, bMonth, bDay] = m.birthdate.split('-');
        if (!bMonth || !bDay) return;

        const mth = parseInt(bMonth) - 1;
        const day = parseInt(bDay);

        let bDateThisYear = new Date(today.getFullYear(), mth, day);
        let diffTime = bDateThisYear.getTime() - today.getTime();
        let diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays > 180) {
            bDateThisYear = new Date(today.getFullYear() - 1, mth, day);
            diffDays = Math.round((bDateThisYear.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        } else if (diffDays < -180) {
            bDateThisYear = new Date(today.getFullYear() + 1, mth, day);
            diffDays = Math.round((bDateThisYear.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        }

        const inCurrentMonth = (mth === today.getMonth());
        const inWindow = (diffDays >= -7 && diffDays <= 7);

        if (inCurrentMonth || inWindow) {
            seenIds.add(m.id);
            upcomingBirthdays.push({ member: m, diffDays, mth, day });
        }
    });

    upcomingBirthdays.sort((a, b) => a.diffDays - b.diffDays);

    const bdayContainer = document.getElementById('dash-birthdays-container');
    const bdayList = document.getElementById('dash-birthdays-list');

    if (bdayContainer && bdayList) {
        if (upcomingBirthdays.length > 0) {
            bdayContainer.style.display = 'block';
            bdayList.innerHTML = upcomingBirthdays.map(item => {
                const m = item.member;
                const mth = (item.mth + 1).toString().padStart(2, '0');
                const d = item.day.toString().padStart(2, '0');
                const diffDays = item.diffDays;

                let badgeText = '';
                const isToday = diffDays === 0;
                if (isToday) badgeText = 'النهاردة! 🎂';
                else if (diffDays === 1) badgeText = 'بكرة';
                else if (diffDays === 2) badgeText = 'بعد يومين';
                else if (diffDays > 2) badgeText = `بعد ${diffDays} أيام`;
                else if (diffDays === -1) badgeText = 'امبارح';
                else if (diffDays === -2) badgeText = 'أول امبارح';
                else if (diffDays < -2) badgeText = `من ${Math.abs(diffDays)} أيام`;

                return `
                <div class="dash-birthday-card ${isToday ? 'is-today-card' : ''}">
                    <div class="bday-icon-box ${isToday ? 'box-gold' : 'box-sparkle'}">
                        <i class="ph ${isToday ? 'ph-gift' : 'ph-cake'}"></i>
                    </div>
                    <div class="bday-info">
                        <div class="bday-name">${esc(m.name)}</div>
                        <div class="bday-date-row">
                            <span class="bday-date">${d}/${mth}</span>
                            <span class="bday-badge ${isToday ? 'badge-today' : 'badge-soon'}">${badgeText}</span>
                        </div>
                    </div>
                </div>`;
            }).join('');
        } else {
            bdayContainer.style.display = 'none';
        }
    }

    // Draw Chart
    const ctx = document.getElementById('attendanceChart').getContext('2d');
    if (currentChart) currentChart.destroy();

    // Take only last 10
    const displayLabels = chartLabels.slice(-10);
    const displayData = chartData.slice(-10);

    const peakVal = displayData.length > 0 ? Math.max(...displayData) : highestMonth;
    const peakTag = document.getElementById('dash-peak-tag');
    if (peakTag) peakTag.innerText = `أعلى قمة: ${peakVal}`;

    const formattedLabels = displayLabels.map((date, idx) => {
        const val = displayData[idx];
        const parts = date.split('-');
        let short = parts.length === 3 ? `${parts[1]}/${parts[2]}` : date;
        if (val === peakVal && peakVal > 0) {
            short += ' (الذروة)';
        }
        return short;
    });

    const gradient = ctx.createLinearGradient(0, 0, 0, 180);
    gradient.addColorStop(0, 'rgba(91, 97, 244, 0.45)');
    gradient.addColorStop(1, 'rgba(91, 97, 244, 0.0)');

    currentChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: formattedLabels,
            datasets: [{
                label: 'عدد الحضور',
                data: displayData,
                borderColor: '#5b61f4',
                backgroundColor: gradient,
                borderWidth: 3,
                tension: 0.45,
                fill: true,
                pointBackgroundColor: displayData.map(v => v === peakVal ? '#ffffff' : '#5b61f4'),
                pointBorderColor: displayData.map(v => v === peakVal ? '#5b61f4' : 'transparent'),
                pointBorderWidth: 2,
                pointRadius: displayData.map(v => v === peakVal ? 6 : 4),
                pointHoverRadius: 7
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#64748b' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8' }
                }
            }
        }
    });
}


// --- Attendance Logic ---
let currentAttendanceDate = null;

function setupAttendanceView() {
    // Set today as default in date picker
    document.getElementById('attendance-date').value = todayLocal();

    // Tab switching (Stitch _5 Nocturne Ecclesia Layout)
    document.getElementById('tab-attendance-general').addEventListener('click', (e) => {
        document.getElementById('tab-attendance-general').classList.add('active');
        document.getElementById('tab-attendance-general').classList.remove('btn-outline');
        document.getElementById('tab-attendance-general').classList.add('btn-primary');

        document.getElementById('tab-attendance-servants').classList.remove('active');
        document.getElementById('tab-attendance-servants').classList.add('btn-outline');
        document.getElementById('tab-attendance-servants').classList.remove('btn-primary');

        const membersList = document.getElementById('attendance-members-list');
        const servantsList = document.getElementById('attendance-servants-list');
        if (membersList) {
            membersList.classList.remove('tab-hidden');
            membersList.style.setProperty('display', 'flex', 'important');
        }
        if (servantsList) {
            servantsList.classList.add('tab-hidden');
            servantsList.style.setProperty('display', 'none', 'important');
        }

        // ensure live counter and KPI card are visible
        const kpiCard = document.getElementById('attendance-kpi-card');
        if (kpiCard) kpiCard.style.display = 'flex';
        const liveCounter = document.getElementById('live-attendance-count');
        if (liveCounter && liveCounter.parentElement) liveCounter.parentElement.style.display = 'flex';
    });

    document.getElementById('tab-attendance-servants').addEventListener('click', (e) => {
        document.getElementById('tab-attendance-servants').classList.add('active');
        document.getElementById('tab-attendance-servants').classList.remove('btn-outline');
        document.getElementById('tab-attendance-servants').classList.add('btn-primary');

        document.getElementById('tab-attendance-general').classList.remove('active');
        document.getElementById('tab-attendance-general').classList.add('btn-outline');
        document.getElementById('tab-attendance-general').classList.remove('btn-primary');

        const membersList = document.getElementById('attendance-members-list');
        const servantsList = document.getElementById('attendance-servants-list');
        if (servantsList) {
            servantsList.classList.remove('tab-hidden');
            servantsList.style.setProperty('display', 'flex', 'important');
        }
        if (membersList) {
            membersList.classList.add('tab-hidden');
            membersList.style.setProperty('display', 'none', 'important');
        }

        // hide live counter on this tab as it is for evaluation
        const kpiCard = document.getElementById('attendance-kpi-card');
        if (kpiCard) kpiCard.style.display = 'none';
        const liveCounter = document.getElementById('live-attendance-count');
        if (liveCounter && liveCounter.parentElement) liveCounter.parentElement.style.display = 'none';

        if (typeof updateServantsEvalNotice === 'function') {
            updateServantsEvalNotice();
        }
    });

    // Mobile edit date toggle button
    const btnEditDateMobile = document.getElementById('btn-edit-date-mobile');
    if (btnEditDateMobile) {
        btnEditDateMobile.addEventListener('click', () => {
            const setupHeader = document.getElementById('attendance-setup-header');
            if (setupHeader) setupHeader.classList.toggle('mobile-open');
        });
    }

    // Day type change listener
    const dayTypeSelect = document.getElementById('attendance-day-type');
    if (dayTypeSelect) {
        dayTypeSelect.addEventListener('change', () => {
            const dayTypeMap = {
                'normal': 'يوم عادي',
                'party': 'حفلة',
                'evening': 'أمسية',
                'funday': 'Fun Day',
                'trip': 'رحلة',
                'conference': 'مؤتمر',
                'holiday': 'إجازة'
            };
            const labelEl = document.getElementById('current-day-type-label');
            if (labelEl) labelEl.innerText = dayTypeMap[dayTypeSelect.value] || 'يوم عادي';
        });
    }

    document.getElementById('btn-start-day').addEventListener('click', () => {
        const dateInput = document.getElementById('attendance-date').value;
        if (!dateInput) return alert('اختر تاريخاً أولاً');
        currentAttendanceDate = dateInput;
        document.getElementById('attendance-setup-header')?.classList.remove('mobile-open');
        updateAttendanceWorkspace();
    });

    document.getElementById('btn-save-attendance').addEventListener('click', () => {
        if (!currentAttendanceDate) return;
        if (currentUserRole !== 'admin' && !currentPermissions.includes('attendance-edit')) {
            alert('عفواً، حسابك يملك صلاحية المشاهدة فقط ولا يمكنه تعديل أو حفظ الحضور.');
            return;
        }

        const records = getAttendanceRecords();
        const servantRecords = getServantRecords();
        const attendedIds = [];

        if (!servantRecords[currentAttendanceDate]) servantRecords[currentAttendanceDate] = {};

        document.getElementById('attendance-members-list').querySelectorAll('.member-attendance-row').forEach(row => {
            const btnAttend = row.querySelector('.btn-attend');
            const memberId = row.getAttribute('data-id');

            if (btnAttend && btnAttend.classList.contains('active')) {
                attendedIds.push(memberId);
            }
        });

        let servantNotes = getServantNotes();
        let notesModified = false;
        const allMembers = getMembers();

        document.getElementById('attendance-servants-list').querySelectorAll('.servant-eval-row').forEach(row => {
            const memberId = row.getAttribute('data-id');
            const isAttending = attendedIds.includes(memberId); // Only save servant stats if they attended
            const isPresented = isAttending && row.querySelector('.servant-presented').checked;
            const autoNoteId = `sn_auto_pres_${memberId}_${currentAttendanceDate}`;
            const existingIdx = servantNotes.findIndex(n => n.id === autoNoteId);

            if (isAttending) {
                servantRecords[currentAttendanceDate][memberId] = {
                    presented: isPresented,
                    leader: row.querySelector('.servant-leader').checked,
                    arrival: row.querySelector('.servant-arrival').value
                };
            } else {
                if (servantRecords[currentAttendanceDate][memberId]) {
                    delete servantRecords[currentAttendanceDate][memberId];
                }
            }

            if (isPresented) {
                const sObj = allMembers.find(m => m.id === memberId);
                const sName = sObj ? sObj.name : '';
                const noteText = `تقديم فقرة في اليوم بتاريخ ${formatDate(currentAttendanceDate)}`;

                if (existingIdx === -1) {
                    servantNotes.unshift({
                        id: autoNoteId,
                        servantId: memberId,
                        servantName: sName,
                        type: 'positive',
                        category: 'تحضير وفقرات',
                        date: currentAttendanceDate,
                        text: noteText,
                        source: 'auto_presented',
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    });
                    notesModified = true;
                } else {
                    if (servantNotes[existingIdx].text !== noteText || servantNotes[existingIdx].type !== 'positive') {
                        servantNotes[existingIdx].text = noteText;
                        servantNotes[existingIdx].type = 'positive';
                        servantNotes[existingIdx].updatedAt = new Date().toISOString();
                        notesModified = true;
                    }
                }
            } else {
                if (existingIdx !== -1) {
                    servantNotes.splice(existingIdx, 1);
                    notesModified = true;
                }
            }
        });

        records[currentAttendanceDate] = attendedIds;
        saveAttendanceRecords(records);
        saveServantRecords(servantRecords);

        if (notesModified) {
            saveServantNotes(servantNotes);
            if (typeof refreshServantsNotes === 'function') {
                refreshServantsNotes();
            }
        }

        const dayTypeSelect = document.getElementById('attendance-day-type');
        if (dayTypeSelect) {
            const dayTypes = getDayTypes();
            dayTypes[currentAttendanceDate] = dayTypeSelect.value;
            saveDayTypes(dayTypes);
        }

        alert('تم حفظ الحضور بنجاح!');
        refreshDashboard();
    });
}

function updateAttendanceWorkspace() {
    const ws = document.getElementById('attendance-workspace');
    const empty = document.getElementById('attendance-empty-state');
    const attView = document.getElementById('attendance-view');
    const mobileSaveBar = document.getElementById('attendance-mobile-save-bar');

    if (!currentAttendanceDate) {
        ws.style.display = 'none';
        empty.style.display = 'block';
        if (attView) attView.classList.remove('has-active-workspace');
        if (mobileSaveBar) mobileSaveBar.style.display = 'none';
        return;
    }

    ws.style.display = 'block';
    empty.style.display = 'none';
    if (attView) attView.classList.add('has-active-workspace');

    // Show mobile save bar if user has permission
    if (mobileSaveBar) {
        const canEditAttendance = currentUserRole === 'admin' || currentPermissions.includes('attendance-edit');
        mobileSaveBar.style.display = canEditAttendance ? 'flex' : 'none';
    }

    // Format Arabic date cleanly without hyphen wrap
    const dObj = new Date(currentAttendanceDate);
    const dayNameAr = !isNaN(dObj) ? dObj.toLocaleDateString('ar-EG', { weekday: 'long' }) : '';
    const formatted = formatDate(currentAttendanceDate);
    const fullDateDisplay = dayNameAr ? `${dayNameAr} (${formatted})` : formatted;

    const desktopDateEl = document.getElementById('current-recording-date');
    if (desktopDateEl) desktopDateEl.innerText = fullDateDisplay;

    const pillDateEl = document.getElementById('current-recording-date-text');
    if (pillDateEl) pillDateEl.innerText = fullDateDisplay;

    // Day type mapping & badge
    const dayTypes = getDayTypes();
    const curDayType = dayTypes[currentAttendanceDate] || 'normal';
    const dayTypeSelect = document.getElementById('attendance-day-type');
    if (dayTypeSelect) dayTypeSelect.value = curDayType;

    const dayTypeMap = {
        'normal': 'يوم عادي',
        'party': 'حفلة',
        'evening': 'أمسية',
        'funday': 'Fun Day',
        'trip': 'رحلة',
        'conference': 'مؤتمر',
        'holiday': 'إجازة'
    };
    const dayTypeLabel = document.getElementById('current-day-type-label');
    if (dayTypeLabel) dayTypeLabel.innerText = dayTypeMap[curDayType] || 'يوم عادي';

    const members = getMembers();
    const records = getAttendanceRecords();
    const todayAttendees = records[currentAttendanceDate] || [];

    const listContainer = document.getElementById('attendance-members-list');
    listContainer.innerHTML = '';

    const servantsListContainer = document.getElementById('attendance-servants-list');
    servantsListContainer.innerHTML = '';

    // Sort members alphabetically
    members.sort((a, b) => a.name.localeCompare(b.name, 'ar'));

    members.forEach(member => {
        const isAttending = todayAttendees.includes(member.id);
        const isServant = member.role === 'servant';

        // --- General Attendance Row (Nocturne Ecclesia _5 Mobile Design) ---
        const row = document.createElement('div');
        row.className = 'member-attendance-row glass';
        row.setAttribute('data-id', member.id);
        row.style.justifyContent = 'space-between';

        const initial = (member.name || '').trim().charAt(0) || 'ع';
        const subtext = member.address || (isServant ? 'خادم بالاجتماع' : 'مخدوم بالاجتماع');

        row.innerHTML = `
            <div class="member-info-wrap">
                <div class="member-avatar">${initial}</div>
                <div style="min-width: 0; overflow: hidden; flex: 1;">
                    <div class="member-name">${esc(member.name)} ${isServant ? '<span class="status-badge badge-warning" style="font-size: 0.65rem; margin-right:4px; padding: 1px 6px;">خادم</span>' : ''}</div>
                    <div class="member-subtext">${esc(subtext)}</div>
                </div>
            </div>
            <div class="toggle-group">
                <button class="toggle-btn btn-attend ${isAttending ? 'active attend' : ''}"><i class="ph ph-check"></i> حضر</button>
                <button class="toggle-btn btn-absent ${!isAttending ? 'active absent' : ''}"><i class="ph ph-x"></i> غاب</button>
            </div>
        `;

        const btnAttend = row.querySelector('.btn-attend');
        const btnAbsent = row.querySelector('.btn-absent');

        btnAttend.addEventListener('click', () => {
            btnAttend.classList.add('active', 'attend');
            btnAbsent.classList.remove('active', 'absent');
            updateLiveCounter();
            // Show their row in servant evaluation list if they are a servant
            if (isServant) {
                const evalRow = servantsListContainer.querySelector(`.servant-eval-row[data-id="${member.id}"]`);
                if (evalRow) {
                    evalRow.setAttribute('data-attended', 'true');
                    const rawQuery = (document.getElementById('search-attendance').value || '').trim();
                    const normQuery = typeof normalizeAr === 'function' ? normalizeAr(rawQuery) : rawQuery.toLowerCase();
                    const evalName = (evalRow.querySelector('.servant-eval-name')?.textContent || evalRow.querySelector('.member-name')?.textContent || '');
                    const normName = typeof normalizeAr === 'function' ? normalizeAr(evalName) : evalName.toLowerCase();
                    evalRow.style.display = (!normQuery || normName.includes(normQuery)) ? 'flex' : 'none';
                }
                updateServantsEvalNotice();
            }
        });

        btnAbsent.addEventListener('click', () => {
            btnAbsent.classList.add('active', 'absent');
            btnAttend.classList.remove('active', 'attend');
            updateLiveCounter();
            // Hide their row in servant evaluation list if they are absent
            if (isServant) {
                const evalRow = servantsListContainer.querySelector(`.servant-eval-row[data-id="${member.id}"]`);
                if (evalRow) {
                    evalRow.setAttribute('data-attended', 'false');
                    evalRow.style.display = 'none';
                }
                updateServantsEvalNotice();
            }
        });

        listContainer.appendChild(row);

        // --- Servant Evaluation Row ---
        if (isServant) {
            const servantRecords = getServantRecords();
            const todayServantData = (servantRecords[currentAttendanceDate] || {})[member.id] || { presented: false, leader: false, arrival: null };

            const evalRow = document.createElement('div');
            evalRow.className = 'servant-eval-row glass';
            evalRow.setAttribute('data-id', member.id);
            evalRow.setAttribute('data-attended', isAttending ? 'true' : 'false');

            const rawQuery = (document.getElementById('search-attendance').value || '').trim();
            const normQuery = typeof normalizeAr === 'function' ? normalizeAr(rawQuery) : rawQuery.toLowerCase();
            const normName = typeof normalizeAr === 'function' ? normalizeAr(member.name) : member.name.toLowerCase();
            const nameMatch = !normQuery || normName.includes(normQuery);
            evalRow.style.display = (isAttending && nameMatch) ? 'flex' : 'none';

            const initial = (member.name || '').trim().charAt(0) || 'خ';

            evalRow.innerHTML = `
                <div class="servant-eval-header">
                    <div class="servant-eval-name">
                        <div class="member-avatar" style="width: 28px; height: 28px; font-size: 0.75rem; background: linear-gradient(135deg, #f59e0b, #d97706);">${initial}</div>
                        <span>${esc(member.name)}</span>
                    </div>
                    <span class="status-badge badge-warning" style="font-size: 0.65rem; padding: 2px 7px;">خادم حاضر</span>
                </div>
                <div class="servant-eval-options">
                    <label class="servant-eval-pill">
                        <input type="checkbox" class="servant-presented" ${todayServantData.presented ? 'checked' : ''}>
                        <span>قدم فقرة النهاردة</span>
                    </label>
                    <label class="servant-eval-pill">
                        <input type="checkbox" class="servant-leader" ${todayServantData.leader ? 'checked' : ''}>
                        <span>مسؤول اليوم</span>
                    </label>
                </div>
                <div class="servant-eval-arrival-wrap">
                    <i class="ph ph-clock"></i>
                    <span>ميعاد الحضور:</span>
                    <select class="form-control servant-arrival">
                        <option value="null" ${!todayServantData.arrival || todayServantData.arrival === 'null' ? 'selected' : ''}>غير محدد</option>
                        <option value="early" ${todayServantData.arrival === 'early' ? 'selected' : ''}>في الأول</option>
                        <option value="middle" ${todayServantData.arrival === 'middle' ? 'selected' : ''}>في النص</option>
                        <option value="late" ${todayServantData.arrival === 'late' ? 'selected' : ''}>في الآخر</option>
                    </select>
                </div>
            `;
            servantsListContainer.appendChild(evalRow);
        }
    });

    // Empty notice when no servant attended yet
    let emptyNotice = document.getElementById('servants-eval-empty-notice');
    if (!emptyNotice) {
        emptyNotice = document.createElement('div');
        emptyNotice.id = 'servants-eval-empty-notice';
        emptyNotice.className = 'servants-empty-notice';
        emptyNotice.innerHTML = `
            <i class="ph ph-user-check"></i>
            <div style="font-weight: 700; color: #ffffff; font-size: 0.92rem; margin-bottom: 4px;">لم يتم تسجيل حضور أي خادم حتى الآن</div>
            <div style="color: #94a3b8; font-size: 0.75rem;">قم بتسجيل حضور الخدام أولاً من تبويب «غياب وحضور» لتتمكن من تقييمهم هنا.</div>
        `;
    }
    servantsListContainer.appendChild(emptyNotice);
    updateServantsEvalNotice();

    updateLiveCounter();
    if (typeof enforcePermissions === 'function') enforcePermissions();
}

function updateServantsEvalNotice() {
    const servantsList = document.getElementById('attendance-servants-list');
    const emptyNotice = document.getElementById('servants-eval-empty-notice');
    if (!servantsList || !emptyNotice) return;
    const rawQuery = (document.getElementById('search-attendance')?.value || '').trim();
    const normQuery = typeof normalizeAr === 'function' ? normalizeAr(rawQuery) : rawQuery.toLowerCase();
    let visibleCount = 0;
    servantsList.querySelectorAll('.servant-eval-row').forEach(row => {
        const isAttended = row.getAttribute('data-attended') === 'true';
        const nameText = (row.querySelector('.servant-eval-name')?.textContent || row.querySelector('.member-name')?.textContent || '');
        const normName = typeof normalizeAr === 'function' ? normalizeAr(nameText) : nameText.toLowerCase();
        if (isAttended && (!normQuery || normName.includes(normQuery))) {
            visibleCount++;
        }
    });
    emptyNotice.style.display = (visibleCount === 0) ? 'block' : 'none';
}

function updateLiveCounter() {
    const count = document.querySelectorAll('#attendance-members-list .btn-attend.active').length;
    const total = getMembers().length;
    const ratio = total > 0 ? Math.round((count / total) * 100) : 0;

    const countEl = document.getElementById('live-attendance-count');
    if (countEl) countEl.innerText = count;

    const totalEl = document.getElementById('attendance-total-members');
    if (totalEl) totalEl.innerText = total;

    const ratioEl = document.getElementById('live-attendance-ratio');
    if (ratioEl) ratioEl.innerText = `${ratio}%`;
}


// --- Follow-up Logic ---
function refreshFollowUp() {
    const members = getMembers();
    const records = getAttendanceRecords();
    const visitations = getVisitations();
    const dates = Object.keys(records).sort((a, b) => b.localeCompare(a)); // Descending (newest first)
    const totalMeetings = dates.length;

    const grid = document.getElementById('followup-members-grid');
    grid.innerHTML = '';

    // Populate region filter
    const regionSelect = document.getElementById('filter-region-followup');
    if (regionSelect) {
        const currentVal = regionSelect.value;
        const uniqueRegions = [...new Set(members.map(m => (m.address || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
        regionSelect.innerHTML = '<option value="">كل المناطق</option>' + uniqueRegions.map(r => `<option value="${r}">${r}</option>`).join('');
        if (uniqueRegions.includes(currentVal)) {
            regionSelect.value = currentVal;
        } else {
            regionSelect.value = '';
        }
    }

    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    oneMonthAgo.setHours(0, 0, 0, 0);

    const nonServants = members.filter(m => m.role !== 'servant');
    nonServants.forEach(member => {
        let attendedCount = 0;
        let consecutiveAbsences = 0;
        let countingConsecutive = true;
        let absentLast = false;
        let lastAttendedDate = 'لم يحضر أبداً';
        let foundLastAttended = false;

        dates.forEach((date, index) => {
            const attended = (records[date] || []).includes(member.id);
            if (attended) {
                attendedCount++;
                countingConsecutive = false; // Broke the streak
                if (!foundLastAttended) {
                    lastAttendedDate = formatDate(date);
                    foundLastAttended = true;
                }
            } else {
                if (countingConsecutive) consecutiveAbsences++;
                if (index === 0) absentLast = true; // Absent in the very last recorded meeting
            }
        });

        const memberVisits = visitations[member.id] || [];
        let lastVisitDate = null;
        let noVisitForMonth = true;

        if (memberVisits.length > 0) {
            memberVisits.sort((a, b) => b.date.localeCompare(a.date));
            lastVisitDate = formatDate(memberVisits[0].date);

            let visitDateObj = new Date(memberVisits[0].date);
            if (isNaN(visitDateObj) && memberVisits[0].date.includes('/')) {
                const parts = memberVisits[0].date.split('/');
                visitDateObj = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
            }

            if (!isNaN(visitDateObj) && visitDateObj >= oneMonthAgo) {
                noVisitForMonth = false;
            }
        }

        let contactedToday = false;
        if (memberVisits.length > 0 && memberVisits[0].date === todayLocal()) {
            contactedToday = true;
        }

        const percentage = totalMeetings > 0 ? Math.round((attendedCount / totalMeetings) * 100) : 0;

        let statusClass = '';
        let badgeHtml = '';
        let filterAttr = 'all';

        if (consecutiveAbsences >= 4) {
            statusClass = 'status-danger';
            badgeHtml += `<span class="status-badge badge-danger" style="font-size: 0.7rem; padding: 2px 6px;">خطر: غائب ${consecutiveAbsences} مرات</span>`;
            filterAttr += ' red';
        } else if (consecutiveAbsences >= 2) {
            statusClass = 'status-warning';
            badgeHtml += `<span class="status-badge badge-warning" style="font-size: 0.7rem; padding: 2px 6px;">إنذار: غائب ${consecutiveAbsences} مرات</span>`;
            filterAttr += ' yellow';
        }

        if (consecutiveAbsences >= 2) {
            filterAttr += ' absent_lot';
        }
        if (noVisitForMonth) {
            filterAttr += ' no_visit_month';
            badgeHtml += `<span class="status-badge badge-warning" style="font-size: 0.7rem; padding: 2px 6px;">تأخر الافتقاد</span>`;
        }
        if (contactedToday) {
            badgeHtml += `<span class="status-badge badge-success" style="font-size: 0.7rem; padding: 2px 6px;"><i class="ph ph-check-circle"></i> تواصل اليوم</span>`;
        }

        if (absentLast) {
            filterAttr += ' absent_last';
        }

        const card = document.createElement('div');
        card.className = `member-card ${statusClass}`;
        card.setAttribute('data-filters', filterAttr);
        card.setAttribute('data-region', (member.address || '').trim());
        card.setAttribute('data-name', (member.name || '').trim());
        card.setAttribute('data-phone', (member.phone || '').trim());

        card.innerHTML = `
            <div class="followup-card-header">
                <div>
                    <h3 class="followup-card-name">
                        ${esc(member.name)}
                        <span class="followup-region-tag">${esc(member.address || 'غير محدد')}</span>
                    </h3>
                    <a class="followup-phone-link" href="tel:${member.phone || ''}">
                        <i class="ph ph-phone"></i>
                        <span>${member.phone || 'لا يوجد رقم'}</span>
                    </a>
                </div>
                <div class="followup-badges-stack">
                    ${badgeHtml}
                </div>
            </div>

            <div class="followup-stats-grid">
                <div class="followup-stat-cell">
                    <div class="stat-cell-label">
                        <i class="ph ph-calendar"></i>
                        <span>آخر حضور</span>
                    </div>
                    <div class="stat-cell-val">${lastAttendedDate}</div>
                </div>
                <div class="followup-stat-cell">
                    <div class="stat-cell-label">
                        <i class="ph ph-user-check ${noVisitForMonth ? 'text-amber' : 'text-emerald'}"></i>
                        <span>آخر افتقاد</span>
                    </div>
                    <div class="stat-cell-val ${noVisitForMonth ? 'text-amber font-bold' : 'text-emerald'}">
                        ${lastVisitDate || 'لم يتم الافتقاد'}
                    </div>
                </div>
            </div>

            <div class="followup-progress-wrap">
                <div class="progress-info-row">
                    <span>نسبة الحضور السنوية</span>
                    <span class="progress-val-bold">${percentage}% <span class="progress-sub">(${attendedCount}/${totalMeetings})</span></span>
                </div>
                <div class="progress-track">
                    <div class="progress-bar-fill" style="width: ${percentage}%;"></div>
                </div>
            </div>

            <div class="followup-actions-row">
                <button class="btn-primary-visit" onclick="openRecordVisitModal('${member.id}', '${member.name.replace(/'/g, "\\'")}')">
                    <i class="ph ph-user-plus"></i>
                    <span>توثيق افتقاد</span>
                </button>
                ${member.phone ? `
                <a href="https://wa.me/2${member.phone.startsWith('0') ? member.phone : '0' + member.phone}" target="_blank" class="btn-wa-direct" title="مراسلة واتساب">
                    <i class="ph ph-whatsapp-logo"></i>
                </a>
                ` : ''}
                <button class="btn-profile-card" onclick="openMemberProfile('${member.id}')">
                    <i class="ph ph-user"></i>
                    <span>الملف</span>
                </button>
            </div>
        `;

        grid.appendChild(card);
    });

    if (typeof window.applyFollowupFilters === 'function') {
        window.applyFollowupFilters();
    }
    if (typeof enforcePermissions === 'function') enforcePermissions();
}

function setupViewFilters(viewId, gridSelector, searchId) {
    const filters = document.querySelectorAll(`${viewId} .filter-btn`);
    const searchInput = document.getElementById(searchId);
    const regionSelect = document.getElementById('filter-region-followup');

    const applyFilters = () => {
        const activeFilter = document.querySelector(`${viewId} .filter-btn.active`);
        const filterValue = activeFilter ? activeFilter.getAttribute('data-filter') : 'all';
        const rawQuery = (searchInput ? searchInput.value : '').trim();
        const normQuery = typeof normalizeAr === 'function' ? normalizeAr(rawQuery) : rawQuery.toLowerCase();
        const cleanPhoneQuery = rawQuery.replace(/[^0-9]/g, '');

        const selectedRegion = (viewId === '#followup-view' && regionSelect) ? regionSelect.value.trim() : '';
        const normSelectedRegion = typeof normalizeAr === 'function' ? normalizeAr(selectedRegion) : selectedRegion.toLowerCase();

        let visibleCount = 0;
        document.querySelectorAll(`${gridSelector} .member-card`).forEach(card => {
            const cardName = card.getAttribute('data-name') || card.querySelector('h3')?.textContent || '';
            const cardPhone = card.getAttribute('data-phone') || '';
            const cardRegion = (card.getAttribute('data-region') || '').trim();
            const cardFilters = (card.getAttribute('data-filters') || '').split(/\s+/);

            const normName = typeof normalizeAr === 'function' ? normalizeAr(cardName) : cardName.toLowerCase();
            const cleanCardPhone = cardPhone.replace(/[^0-9]/g, '');

            // 1. Search Match (by Name or by Phone)
            let matchesSearch = true;
            if (rawQuery) {
                const nameMatches = normName.includes(normQuery);
                const phoneMatches = Boolean(cleanPhoneQuery && cleanCardPhone.includes(cleanPhoneQuery));
                matchesSearch = nameMatches || phoneMatches;
            }

            // 2. Status Filter Match
            const matchesFilter = (filterValue === 'all') || cardFilters.includes(filterValue);

            // 3. Region Filter Match
            let matchesRegion = true;
            if (selectedRegion) {
                const normCardRegion = typeof normalizeAr === 'function' ? normalizeAr(cardRegion) : cardRegion.toLowerCase();
                matchesRegion = (normCardRegion === normSelectedRegion) || normCardRegion.includes(normSelectedRegion);
            }

            const isVisible = Boolean(matchesSearch && matchesFilter && matchesRegion);
            card.style.display = isVisible ? 'block' : 'none';
            if (isVisible) visibleCount++;
        });

        // Empty state message when no results match
        let emptyMsg = document.getElementById('followup-filter-empty-msg');
        if (visibleCount === 0) {
            if (!emptyMsg) {
                emptyMsg = document.createElement('div');
                emptyMsg.id = 'followup-filter-empty-msg';
                emptyMsg.className = 'empty-state';
                emptyMsg.style.gridColumn = '1 / -1';
                emptyMsg.style.textAlign = 'center';
                emptyMsg.style.padding = '40px 20px';
                emptyMsg.innerHTML = '<i class="ph ph-magnifying-glass" style="font-size: 2.5rem; color: var(--text-muted); margin-bottom: 10px; display: block;"></i><h3 style="color: var(--text-muted); font-size: 1.1rem; margin-bottom: 5px;">لا توجد نتائج مطابقة</h3><p style="color: var(--text-muted); font-size: 0.88rem;">جرّب اختيار منطقة أخرى أو مسح نص البحث</p>';
                const grid = document.querySelector(gridSelector);
                if (grid) grid.appendChild(emptyMsg);
            } else {
                emptyMsg.style.display = 'block';
            }
        } else if (emptyMsg) {
            emptyMsg.style.display = 'none';
        }
    };

    window.applyFollowupFilters = applyFilters;

    if (viewId === '#followup-view' && regionSelect) {
        regionSelect.addEventListener('change', applyFilters);
    }

    filters.forEach(btn => {
        btn.addEventListener('click', () => {
            filters.forEach(f => f.classList.remove('active'));
            btn.classList.add('active');
            applyFilters();
        });
    });

    if (searchInput) {
        searchInput.addEventListener('input', applyFilters);
    }
}


// --- Visitation Logic ---
function setupCopyNeedsVisit() {
    const btnAbsentLast = document.getElementById('btn-copy-absent-last');
    const btnNoVisit = document.getElementById('btn-copy-no-visit');

    function copyList(mode) {
        const members = getMembers().filter(m => m.role !== 'servant');
        const records = getAttendanceRecords();
        const visitations = getVisitations();
        const dates = Object.keys(records).sort((a, b) => b.localeCompare(a));

        const lastMeetingDate = dates.length > 0 ? dates[0] : null;

        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        oneMonthAgo.setHours(0, 0, 0, 0);

        let listText = mode === 'absent_last'
            ? "قائمة الأشخاص الذين غابوا آخر اجتماع:\n\n"
            : "قائمة الأشخاص المتأخر افتقادهم لأكثر من شهر:\n\n";
        let count = 0;

        members.forEach(m => {
            let absentLast = false;
            if (lastMeetingDate) {
                if (!(records[lastMeetingDate] || []).includes(m.id)) {
                    absentLast = true;
                }
            }

            const memberVisits = visitations[m.id] || [];
            let noVisitForMonth = true;
            if (memberVisits.length > 0) {
                memberVisits.sort((a, b) => b.date.localeCompare(a.date));
                let visitDateObj = new Date(memberVisits[0].date);
                if (isNaN(visitDateObj) && memberVisits[0].date.includes('/')) {
                    const parts = memberVisits[0].date.split('/');
                    visitDateObj = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
                }
                if (!isNaN(visitDateObj) && visitDateObj >= oneMonthAgo) {
                    noVisitForMonth = false;
                }
            }

            const shouldInclude = mode === 'absent_last' ? absentLast : noVisitForMonth;

            if (shouldInclude) {
                count++;
                listText += `${count}. ${m.name}${m.address ? ' - ' + m.address : ''}\n`;
            }
        });

        if (count === 0) {
            alert('لا يوجد أشخاص متطابقين مع الشروط المختارة');
            return;
        }

        navigator.clipboard.writeText(listText).then(() => {
            alert(`تم نسخ قائمة بـ ${count} مخدومين بنجاح!`);
        }).catch(err => {
            console.error('Failed to copy: ', err);
            alert('حدث خطأ أثناء النسخ. برجاء المحاولة مرة أخرى.');
        });
    }

    if (btnAbsentLast) {
        btnAbsentLast.addEventListener('click', () => {
            if (currentUserRole !== 'admin') {
                alert('عفواً، ميزة نسخ غياب آخر اجتماع خاصة بالأدمن فقط.');
                return;
            }
            copyList('absent_last');
        });
    }
    if (btnNoVisit) {
        btnNoVisit.addEventListener('click', () => {
            if (currentUserRole !== 'admin') {
                alert('عفواً، ميزة نسخ تأخر الافتقاد خاصة بالأدمن فقط.');
                return;
            }
            copyList('no_visit');
        });
    }
}

function setupVisitationModals() {
    // Record visit modal save btn
    document.getElementById('btn-save-visit').addEventListener('click', () => {
        if (currentUserRole !== 'admin' && !currentPermissions.includes('followup-edit')) {
            alert('عفواً، لا تملك صلاحية تسجيل أو تعديل الافتقاد (المشاهدة فقط).');
            return;
        }
        const memberId = document.getElementById('visit-member-id').value;
        const date = document.getElementById('visit-date').value;
        const positives = document.getElementById('visit-positives').value;
        const problems = document.getElementById('visit-problems').value;
        const method = document.getElementById('visit-method').value;

        const servantCbs = document.querySelectorAll('.visit-servant-cb:checked');
        const selectedServantIds = Array.from(servantCbs).map(cb => cb.value);

        if (!date) return alert('برجاء اختيار تاريخ الزيارة');

        const visitations = getVisitations();
        if (!visitations[memberId]) visitations[memberId] = [];

        visitations[memberId].push({
            date, servants: selectedServantIds, positives, problems, method
        });

        // Sort by date descending
        visitations[memberId].sort((a, b) => b.date.localeCompare(a.date));

        saveVisitations(visitations);

        document.getElementById('record-visitation-modal-bg').classList.remove('active');
        refreshFollowUp();
        alert('تم حفظ الزيارة بنجاح!');
    });

    // Bulk visit modal open btn
    const btnOpenBulk = document.getElementById('btn-open-bulk-visit');
    if (btnOpenBulk) {
        btnOpenBulk.addEventListener('click', () => {
            if (currentUserRole !== 'admin') {
                alert('عفواً، ميزة الافتقاد الجماعي خاصة بالأدمن فقط.');
                return;
            }
            document.getElementById('bulk-visit-date').value = todayLocal();
            document.getElementById('bulk-visit-positives').value = '';
            document.getElementById('bulk-visit-problems').value = '';
            document.getElementById('bulk-visit-search-members').value = '';

            // Populate Servants checkboxes
            const members = getMembers();
            const servants = members.filter(m => m.role === 'servant');
            const servantsContainer = document.getElementById('bulk-visit-servants-checkboxes');
            servantsContainer.innerHTML = '';

            if (servants.length === 0) {
                servantsContainer.innerHTML = '<span style="color:var(--text-muted); font-size:0.85rem;">لا يوجد خدام مسجلين.</span>';
            } else {
                servants.forEach(s => {
                    const shortName = s.name.split(' ')[0] + (s.name.split(' ').length > 1 ? ' ' + s.name.split(' ')[1] : '');
                    servantsContainer.innerHTML += `
                        <label style="display: flex; align-items: center; gap: 5px; cursor: pointer; background: var(--glass-border); padding: 5px 10px; border-radius: 5px; font-size: 0.9rem;">
                            <input type="checkbox" value="${s.id}" class="bulk-visit-servant-cb">
                            ${shortName}
                        </label>
                    `;
                });
            }

            // Populate Members checkboxes
            const nonServants = members.filter(m => m.role !== 'servant').sort((a, b) => a.name.localeCompare(b.name, 'ar'));
            const membersContainer = document.getElementById('bulk-visit-members-checkboxes');
            membersContainer.innerHTML = '';

            nonServants.forEach(m => {
                membersContainer.innerHTML += `
                    <label class="bulk-member-label" style="display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 5px; border-radius: 5px; background: rgba(255,255,255,0.05);">
                        <input type="checkbox" value="${m.id}" class="bulk-visit-member-cb">
                        <span class="member-name-text" style="color: var(--text);">${m.name}</span>
                    </label>
                `;
            });

            document.getElementById('record-bulk-visitation-modal-bg').classList.add('active');
        });
    }

    // Bulk visit search
    const bulkSearch = document.getElementById('bulk-visit-search-members');
    if (bulkSearch) {
        bulkSearch.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            document.querySelectorAll('.bulk-member-label').forEach(label => {
                const name = label.querySelector('.member-name-text').textContent.toLowerCase();
                label.style.display = name.includes(query) ? 'flex' : 'none';
            });
        });
    }

    // Bulk visit modal save btn
    const btnSaveBulk = document.getElementById('btn-save-bulk-visit');
    if (btnSaveBulk) {
        btnSaveBulk.addEventListener('click', () => {
            if (currentUserRole !== 'admin') {
                alert('عفواً، لا يملك صلاحية حفظ الافتقاد الجماعي إلا الأدمن.');
                return;
            }
            const date = document.getElementById('bulk-visit-date').value;
            const positives = document.getElementById('bulk-visit-positives').value;
            const problems = document.getElementById('bulk-visit-problems').value;
            const method = document.getElementById('bulk-visit-method').value;

            const servantCbs = document.querySelectorAll('.bulk-visit-servant-cb:checked');
            const selectedServantIds = Array.from(servantCbs).map(cb => cb.value);

            const memberCbs = document.querySelectorAll('.bulk-visit-member-cb:checked');
            const selectedMemberIds = Array.from(memberCbs).map(cb => cb.value);

            if (!date) return alert('برجاء اختيار تاريخ الزيارة');
            if (selectedMemberIds.length === 0) return alert('برجاء اختيار مخدوم واحد على الأقل');

            const visitations = getVisitations();

            selectedMemberIds.forEach(memberId => {
                if (!visitations[memberId]) visitations[memberId] = [];
                visitations[memberId].push({
                    date, servants: selectedServantIds, positives, problems, method
                });
                visitations[memberId].sort((a, b) => b.date.localeCompare(a.date));
            });

            saveVisitations(visitations);

            document.getElementById('record-bulk-visitation-modal-bg').classList.remove('active');
            refreshFollowUp();
            alert('تم حفظ الافتقاد الجماعي بنجاح!');
        });
    }
}

window.openRecordVisitModal = function (memberId, memberName) {
    document.getElementById('visit-member-id').value = memberId;
    document.getElementById('visit-member-name').innerText = `تسجيل افتقاد: ${memberName}`;
    document.getElementById('visit-date').value = todayLocal();
    document.getElementById('visit-positives').value = '';
    document.getElementById('visit-problems').value = '';

    // Populate Servants checkboxes
    const members = getMembers();
    const servants = members.filter(m => m.role === 'servant');
    const container = document.getElementById('visit-servants-checkboxes');
    container.innerHTML = '';

    if (servants.length === 0) {
        container.innerHTML = '<span style="color:var(--text-muted); font-size:0.85rem;">لا يوجد خدام مسجلين. برجاء إضافة خدام من إدارة الأعضاء.</span>';
    } else {
        servants.forEach(s => {
            const shortName = s.name.split(' ')[0] + (s.name.split(' ').length > 1 ? ' ' + s.name.split(' ')[1] : '');
            container.innerHTML += `
                <label style="display: flex; align-items: center; gap: 5px; cursor: pointer; background: var(--glass-border); padding: 5px 10px; border-radius: 5px; font-size: 0.9rem;">
                    <input type="checkbox" value="${s.id}" class="visit-servant-cb">
                    ${shortName}
                </label>
            `;
        });
    }

    document.getElementById('record-visitation-modal-bg').classList.add('active');
}

window.openMemberProfile = function (memberId) {
    const members = getMembers();
    const member = members.find(m => m.id === memberId);
    if (!member) return;

    const records = getAttendanceRecords();
    const dates = Object.keys(records).sort((a, b) => b.localeCompare(a));
    const totalMeetings = dates.length;

    let attendedCount = 0;
    let lastAttendedDate = '--';
    let foundLast = false;

    dates.forEach(date => {
        if ((records[date] || []).includes(memberId)) {
            attendedCount++;
            if (!foundLast) {
                lastAttendedDate = formatDate(date);
                foundLast = true;
            }
        }
    });

    const percentage = totalMeetings > 0 ? Math.round((attendedCount / totalMeetings) * 100) : 0;

    document.getElementById('profile-name').innerText = member.name;
    document.getElementById('profile-phone').innerText = member.phone || 'لا يوجد رقم هاتف';
    document.getElementById('profile-attendance-rate').innerText = `${percentage}%`;
    document.getElementById('profile-last-attend').innerText = `آخر حضور: ${lastAttendedDate}`;

    // Edit Phone Button
    const editPhoneBtn = document.getElementById('btn-edit-phone');
    // Remove old listeners by cloning
    const newEditBtn = editPhoneBtn.cloneNode(true);
    editPhoneBtn.parentNode.replaceChild(newEditBtn, editPhoneBtn);
    newEditBtn.addEventListener('click', async () => {
        const currentPhone = member.phone || '';
        const newPhone = await customPrompt('أدخل رقم الواتساب الجديد:', currentPhone);
        if (newPhone !== null) {
            let allMembers = getMembers();
            const idx = allMembers.findIndex(m => m.id === memberId);
            if (idx !== -1) {
                allMembers[idx].phone = newPhone.trim();
                saveMembers(allMembers);
                member.phone = newPhone.trim();
                document.getElementById('profile-phone').innerText = member.phone || 'لا يوجد رقم هاتف';
                showToast('تم حفظ رقم الهاتف بنجاح!', 'success');
            }
        }
    });

    // Gender
    const memberGender = member.gender === 'female' ? 'أنثى' : 'ذكر';
    document.getElementById('profile-gender').innerText = `النوع: ${memberGender}`;

    // Edit Gender Button
    const editGenderBtn = document.getElementById('btn-edit-gender');
    const newEditGenderBtn = editGenderBtn.cloneNode(true);
    editGenderBtn.parentNode.replaceChild(newEditGenderBtn, editGenderBtn);
    newEditGenderBtn.addEventListener('click', async () => {
        const isMale = member.gender !== 'female';
        const confirmMsg = isMale ? 'هل تريد تغيير النوع إلى (أنثى)؟' : 'هل تريد تغيير النوع إلى (ذكر)؟';
        if (await customConfirm(confirmMsg)) {
            let allMembers = getMembers();
            const idx = allMembers.findIndex(m => m.id === memberId);
            if (idx !== -1) {
                const newGender = isMale ? 'female' : 'male';
                allMembers[idx].gender = newGender;
                saveMembers(allMembers);
                member.gender = newGender;
                document.getElementById('profile-gender').innerText = `النوع: ${newGender === 'female' ? 'أنثى' : 'ذكر'}`;
            }
        }
    });

    const visitations = getVisitations();
    const memberVisits = visitations[memberId] || [];

    if (memberVisits.length > 0) {
        document.getElementById('profile-last-visit').innerText = memberVisits[0].date;
    } else {
        document.getElementById('profile-last-visit').innerText = 'لم يفتقد بعد';
    }

    const visitsList = document.getElementById('profile-visits-list');
    visitsList.innerHTML = '';

    if (memberVisits.length === 0) {
        visitsList.innerHTML = '<div class="visit-history-card no-history">لا يوجد سجل زيارات سابق</div>';
    } else {
        memberVisits.forEach(v => {
            let servantNames = v.servants || '--';
            if (Array.isArray(v.servants)) {
                servantNames = v.servants.map(id => {
                    const sm = members.find(m => m.id === id);
                    return sm ? sm.name.split(' ')[0] : 'غير معروف';
                }).join('، ');
            }

            let methodBadge = '';
            if (v.method) {
                let badgeColor = 'badge-primary';
                if (v.method === 'زيارة منزلية') badgeColor = 'badge-success';
                else if (v.method === 'تليفون / واتساب') badgeColor = 'badge-warning';
                methodBadge = `<span class="status-badge ${badgeColor}" style="font-size: 0.75rem;">${v.method}</span>`;
            }

            visitsList.innerHTML += `
                <div class="visit-history-card glass">
                    <div class="visit-history-header">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <span class="date"><i class="ph ph-calendar"></i> ${formatDate(v.date)}</span>
                            ${methodBadge}
                        </div>
                        <span><i class="ph ph-users"></i> ${servantNames}</span>
                    </div>
                    <div class="visit-history-body">
                        ${v.positives ? `<p><strong>الإيجابيات:</strong> ${v.positives}</p>` : ''}
                        ${v.problems ? `<p><strong>الشكاوى:</strong> ${v.problems}</p>` : ''}
                    </div>
                </div>
            `;
        });
    }

    // Servant Stats Logic
    const servantStatsDiv = document.getElementById('profile-servant-stats');
    if (member.role === 'servant') {
        const servantRecords = getServantRecords();
        let presentedCount = 0;
        let leaderCount = 0;
        let early = 0, middle = 0, late = 0;

        dates.forEach(date => {
            if (servantRecords[date] && servantRecords[date][memberId]) {
                const sData = servantRecords[date][memberId];
                if (sData.presented) presentedCount++;
                if (sData.leader) leaderCount++;
                if (sData.arrival === 'early') early++;
                else if (sData.arrival === 'middle') middle++;
                else if (sData.arrival === 'late') late++;
            }
        });

        // Calculate total visits made by this servant
        let visitsMade = 0;
        Object.values(visitations).forEach(mVisits => {
            mVisits.forEach(v => {
                if (Array.isArray(v.servants) && v.servants.includes(memberId)) {
                    visitsMade++;
                } else if (typeof v.servants === 'string' && v.servants.includes(member.name.split(' ')[0])) {
                    visitsMade++;
                }
            });
        });

        document.getElementById('profile-servant-presented').innerText = presentedCount;
        document.getElementById('profile-servant-leader').innerText = leaderCount;
        document.getElementById('profile-servant-visits').innerText = visitsMade;

        let arrivalText = [];
        if (early > 0) arrivalText.push(`في الأول: ${early}`);
        if (middle > 0) arrivalText.push(`في النص: ${middle}`);
        if (late > 0) arrivalText.push(`في الآخر: ${late}`);

        document.getElementById('profile-servant-arrival').innerText = arrivalText.length > 0 ? arrivalText.join(' | ') : 'لم يتم تسجيل مواعيد حضور';

        servantStatsDiv.style.display = 'block';
    } else {
        servantStatsDiv.style.display = 'none';
    }

    document.getElementById('member-profile-modal-bg').classList.add('active');
}

// Generic filter used instead of setupVisitationFilters


// --- PDF Generation Logic ---
function generatePDFReport(year, month) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('reports-view')) {
        alert('عفواً، لا تملك صلاحية طباعة أو استخراج التقارير.');
        return;
    }
    const members = getMembers();
    const records = getAttendanceRecords();
    const visitations = getVisitations();

    // 1. Filter Attendance Dates for the month
    const allDates = Object.keys(records).sort();
    const monthDates = allDates.filter(d => d.startsWith(`${year}-${month}`));

    // 2. Filter Visitations for the month
    const monthVisits = [];
    Object.keys(visitations).forEach(memberId => {
        const visits = visitations[memberId];
        visits.forEach(v => {
            if (v.date.startsWith(`${year}-${month}`)) {
                const mName = members.find(m => m.id === memberId)?.name || 'غير معروف';
                monthVisits.push({ ...v, memberName: mName });
            }
        });
    });
    monthVisits.sort((a, b) => b.date.localeCompare(a.date));

    // 3. Build HTML
    let html = `
        <div class="pdf-report-content" id="report-content-wrapper">
            <div class="pdf-header">
                <h1>تقرير اجتماع القديس يوحنا الحبيب</h1>
                <h2>شهر: ${month} / ${year}</h2>
            </div>
            
            <div class="pdf-summary">
                <span>إجمالي الأعضاء: ${members.length}</span>
                <span>إجمالي اجتماعات الشهر: ${monthDates.length}</span>
                <span>إجمالي افتقادات الشهر: ${monthVisits.length}</span>
            </div>
    `;

    // Attendance Table
    if (monthDates.length > 0) {
        html += `<h3 class="pdf-section-title">تقرير الحضور والغياب</h3>`;
        html += `<table class="pdf-table"><thead><tr><th>الاسم</th><th>المنطقة / العنوان</th>`;
        monthDates.forEach(d => {
            html += `<th>${d.substring(5)}</th>`; // show only MM-DD
        });
        html += `<th>النسبة</th></tr></thead><tbody>`;

        members.forEach(m => {
            let attendCount = 0;
            let rowHtml = `<tr><td>${m.name}</td><td>${m.address || '--'}</td>`;
            monthDates.forEach(d => {
                const attended = (records[d] || []).includes(m.id);
                if (attended) attendCount++;
                rowHtml += `<td>${attended ? '<span style="color: #059669; font-weight: bold;">✔</span>' : '<span style="color: #dc2626; font-weight: bold;">✘</span>'}</td>`;
            });
            const pct = Math.round((attendCount / monthDates.length) * 100);

            rowHtml += `<td>${pct}%</td></tr>`;
            html += rowHtml;
        });
        html += `</tbody></table>`;
    } else {
        html += `<p style="text-align:center;">لا توجد سجلات حضور مسجلة في هذا الشهر.</p>`;
    }

    // Visitations Table
    html += `<h3 class="pdf-section-title">تقرير الافتقاد</h3>`;
    if (monthVisits.length > 0) {
        html += `<table class="pdf-table"><thead><tr>
            <th>التاريخ</th>
            <th>المخدوم</th>
            <th>الخدام</th>
            <th>ملاحظات</th>
        </tr></thead><tbody>`;
        monthVisits.forEach(v => {
            let servantNames = v.servants || '--';
            if (Array.isArray(v.servants)) {
                servantNames = v.servants.map(id => {
                    const sm = members.find(m => m.id === id);
                    return sm ? sm.name.split(' ')[0] : 'غير معروف';
                }).join('، ');
            }
            html += `<tr>
                <td>${formatDate(v.date)}</td>
                <td>${v.memberName}</td>
                <td>${servantNames}</td>
                <td style="text-align: right; padding-right: 10px;">
                    ${v.positives ? `<b>إيجابيات:</b> ${v.positives}<br>` : ''}
                    ${v.problems ? `<b>شكاوى:</b> ${v.problems}` : ''}
                    ${!v.positives && !v.problems ? '--' : ''}
                </td>
            </tr>`;
        });
        html += `</tbody></table>`;
    } else {
        html += `<p style="text-align:center;">لا توجد سجلات افتقاد مسجلة في هذا الشهر.</p>`;
    }

    html += `</div>`;

    const container = document.getElementById('pdf-report-container');
    container.innerHTML = html;
    container.style.display = 'block';

    const element = document.getElementById('report-content-wrapper');

    const opt = {
        margin: 10,
        filename: `تقرير_الاجتماع_${year}_${month}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    const btn = document.getElementById('btn-generate-pdf');
    const oldText = btn.innerHTML;
    btn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> جاري التحضير...';
    btn.disabled = true;

    html2pdf().set(opt).from(element).save().then(() => {
        container.style.display = 'none';
        btn.innerHTML = oldText;
        btn.disabled = false;
    }).catch(err => {
        console.error(err);
        container.style.display = 'none';
        btn.innerHTML = oldText;
        btn.disabled = false;
        alert('حدث خطأ أثناء إنشاء التقرير.');
    });
}

function generateVisitationPDFReport(year, month) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('reports-view')) {
        alert('عفواً، لا تملك صلاحية طباعة أو استخراج التقارير.');
        return;
    }
    const members = getMembers();
    const visitations = getVisitations();

    // Filter Visitations for the month
    const monthVisits = [];
    Object.keys(visitations).forEach(memberId => {
        const visits = visitations[memberId];
        visits.forEach(v => {
            if (v.date.startsWith(`${year}-${month}`)) {
                const mName = members.find(m => m.id === memberId)?.name || 'غير معروف';
                monthVisits.push({ ...v, memberName: mName });
            }
        });
    });
    monthVisits.sort((a, b) => b.date.localeCompare(a.date));

    // Build HTML
    let html = `
        <div class="pdf-report-content" id="report-content-wrapper">
            <div class="pdf-header">
                <h1>تقرير افتقاد اجتماع القديس يوحنا الحبيب</h1>
                <h2>شهر: ${month} / ${year}</h2>
            </div>
            
            <div class="pdf-summary">
                <span>إجمالي افتقادات الشهر: ${monthVisits.length}</span>
            </div>
    `;

    // Visitations Table
    html += `<h3 class="pdf-section-title">تقرير الافتقاد</h3>`;
    if (monthVisits.length > 0) {
        html += `<table class="pdf-table"><thead><tr>
            <th>التاريخ</th>
            <th>المخدوم</th>
            <th>الخدام</th>
            <th>ملاحظات</th>
        </tr></thead><tbody>`;
        monthVisits.forEach(v => {
            let servantNames = v.servants || '--';
            if (Array.isArray(v.servants)) {
                servantNames = v.servants.map(id => {
                    const sm = members.find(m => m.id === id);
                    return sm ? sm.name.split(' ')[0] : 'غير معروف';
                }).join('، ');
            }
            html += `<tr>
                <td>${formatDate(v.date)}</td>
                <td>${v.memberName}</td>
                <td>${servantNames}</td>
                <td style="text-align: right; padding-right: 10px;">
                    ${v.positives ? `<b>إيجابيات:</b> ${v.positives}<br>` : ''}
                    ${v.problems ? `<b>شكاوى:</b> ${v.problems}` : ''}
                    ${!v.positives && !v.problems ? '--' : ''}
                </td>
            </tr>`;
        });
        html += `</tbody></table>`;
    } else {
        html += `<p style="text-align:center;">لا توجد سجلات افتقاد مسجلة في هذا الشهر.</p>`;
    }

    html += `</div>`;

    const container = document.getElementById('pdf-report-container');
    container.innerHTML = html;
    container.style.display = 'block';

    const element = document.getElementById('report-content-wrapper');

    const opt = {
        margin: 10,
        filename: `تقرير_الافتقاد_${year}_${month}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    const btn = document.getElementById('btn-generate-pdf-visit');
    const oldText = btn.innerHTML;
    btn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> جاري التحضير...';
    btn.disabled = true;

    html2pdf().set(opt).from(element).save().then(() => {
        container.style.display = 'none';
        btn.innerHTML = oldText;
        btn.disabled = false;
    }).catch(err => {
        console.error(err);
        container.style.display = 'none';
        btn.innerHTML = oldText;
        btn.disabled = false;
        alert('حدث خطأ أثناء إنشاء التقرير.');
    });
}


// --- Summary Logic ---
function refreshSummaryView() {
    const cardsContainer = document.getElementById('summary-cards-container');
    const oldTableList = document.getElementById('summary-list');
    if (!cardsContainer && !oldTableList) return;

    const records = getAttendanceRecords();
    const servantRecords = getServantRecords();
    const dates = Object.keys(records).sort((a, b) => b.localeCompare(a)); // Descending
    const dayTypes = getDayTypes();
    const members = getMembers();

    const countTag = document.getElementById('summary-records-count');
    if (countTag) countTag.textContent = `${dates.length} سجلات مسجلة`;

    const dayTypeMap = {
        'normal': 'يوم عادي',
        'party': 'حفلة',
        'evening': 'أمسية',
        'funday': 'Fun Day',
        'trip': 'رحلة',
        'conference': 'مؤتمر',
        'holiday': 'إجازة'
    };

    if (dates.length === 0) {
        if (cardsContainer) {
            cardsContainer.innerHTML = '<div class="empty-state"><i class="ph ph-calendar-blank"></i><h3>لا توجد سجلات اجتماعات مسجلة حتى الآن</h3></div>';
        }
        if (oldTableList) {
            oldTableList.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px;">لا يوجد سجلات حتى الآن</td></tr>';
        }
        return;
    }

    // Compute Last Meeting Stats
    const lastDate = dates[0];
    const lastAttendees = records[lastDate] || [];
    let lastMCount = 0;
    let lastSCount = 0;
    lastAttendees.forEach(id => {
        const m = members.find(x => x.id === id);
        if (m) {
            if (m.role === 'servant') lastSCount++;
            else lastMCount++;
        }
    });

    const elLastDate = document.getElementById('summary-kpi-last-date-label');
    const elLastTotal = document.getElementById('summary-kpi-last-total');
    const elLastMembers = document.getElementById('summary-kpi-last-members');
    const elLastServants = document.getElementById('summary-kpi-last-servants');
    if (elLastDate) elLastDate.textContent = `آخر اجتماع (${lastDate.slice(5)})`;
    if (elLastTotal) elLastTotal.textContent = lastAttendees.length;
    if (elLastMembers) elLastMembers.textContent = lastMCount;
    if (elLastServants) elLastServants.textContent = lastSCount;

    // Compute Highest Attendance Meeting
    let highestDate = dates[0];
    let highestCount = (records[dates[0]] || []).length;
    dates.forEach(d => {
        const count = (records[d] || []).length;
        if (count > highestCount) {
            highestCount = count;
            highestDate = d;
        }
    });

    const highestTypeKey = dayTypes[highestDate] || 'normal';
    const highestTypeStr = dayTypeMap[highestTypeKey] || 'عادي';
    let highestSegments = 0;
    const hSRecords = servantRecords[highestDate] || {};
    Object.values(hSRecords).forEach(s => { if (s.presented) highestSegments++; });

    const elHighType = document.getElementById('summary-kpi-highest-type-label');
    const elHighTotal = document.getElementById('summary-kpi-highest-total');
    const elHighSegs = document.getElementById('summary-kpi-highest-segments');
    const elHighDate = document.getElementById('summary-kpi-highest-date');
    if (elHighType) elHighType.textContent = `أعلى حضور (${highestTypeStr})`;
    if (elHighTotal) elHighTotal.textContent = highestCount;
    if (elHighSegs) elHighSegs.textContent = highestSegments;
    if (elHighDate) elHighDate.textContent = highestDate;

    // Render Weekly Meeting Cards
    if (cardsContainer) {
        cardsContainer.innerHTML = '';
        dates.forEach(date => {
            const attendees = records[date] || [];
            const attendanceCount = attendees.length;
            let mCount = 0;
            let sCount = 0;
            attendees.forEach(id => {
                const m = members.find(x => x.id === id);
                if (m) {
                    if (m.role === 'servant') sCount++;
                    else mCount++;
                }
            });

            const typeKey = dayTypes[date] || 'normal';
            const typeStr = dayTypeMap[typeKey] || 'عادي';
            let segmentsCount = 0;
            const sRecords = servantRecords[date] || {};
            Object.values(sRecords).forEach(sData => {
                if (sData.presented) segmentsCount++;
            });

            const dObj = new Date(date);
            const dayNameAr = !isNaN(dObj) ? dObj.toLocaleDateString('ar-EG', { weekday: 'long' }) : 'اللقاء';
            const isHighest = (date === highestDate && highestCount > 0);

            const card = document.createElement('article');
            card.className = `summary-meeting-card ${isHighest ? 'is-highest-record' : ''}`;
            card.innerHTML = `
                ${isHighest ? '<div class="highest-ribbon"><span>أعلى حضور</span></div>' : ''}
                <div class="summary-card-top">
                    <div class="summary-card-day-info">
                        <span class="summary-card-day-title">
                            ${dayNameAr}
                            <span class="summary-card-date">${date}</span>
                        </span>
                        <span class="summary-day-badge badge-${typeKey}">${typeStr}</span>
                    </div>
                    <div class="summary-card-actions">
                        <button class="summary-btn-edit" onclick="editDayAttendance('${date}')" title="تعديل السجل">
                            <i class="ph ph-pencil-simple"></i>
                            <span>تعديل</span>
                        </button>
                        ${currentUserRole === 'admin' ? `
                        <button class="summary-btn-delete" onclick="deleteDayAttendance('${date}')" title="حذف السجل">
                            <i class="ph ph-trash"></i>
                        </button>` : ''}
                    </div>
                </div>
                <div class="summary-card-metrics-grid">
                    <div class="summary-metric-cell metric-total">
                        <span class="metric-label">الإجمالي</span>
                        <span class="metric-val text-emerald">${attendanceCount}</span>
                    </div>
                    <div class="summary-metric-cell">
                        <span class="metric-label">مخدومين</span>
                        <span class="metric-val">${mCount}</span>
                    </div>
                    <div class="summary-metric-cell">
                        <span class="metric-label">خدام</span>
                        <span class="metric-val">${sCount}</span>
                    </div>
                    <div class="summary-metric-cell">
                        <span class="metric-label">فقرات</span>
                        <span class="metric-val ${segmentsCount > 0 ? 'text-indigo' : ''}">${segmentsCount}</span>
                    </div>
                </div>
            `;
            cardsContainer.appendChild(card);
        });
    }
}

window.deleteDayAttendance = async function (date) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('attendance-edit')) {
        alert('عفواً، لا تملك صلاحية حذف سجلات الأيام (المشاهدة فقط).');
        return;
    }
    const dObj = new Date(date);
    const dayNameAr = !isNaN(dObj) ? dObj.toLocaleDateString('ar-EG', { weekday: 'long' }) : '';
    const label = dayNameAr ? `${dayNameAr} (${date})` : date;

    if (await customConfirm(`هل أنت متأكد من حذف سجل يوم ${label} نهائياً؟`)) {
        const records = getAttendanceRecords();
        delete records[date];
        saveAttendanceRecords(records);

        const dayTypes = getDayTypes();
        delete dayTypes[date];
        saveDayTypes(dayTypes);

        const servantRecords = getServantRecords();
        delete servantRecords[date];
        saveServantRecords(servantRecords);

        // Clean up auto notes for that day
        const notes = getServantNotes().filter(n => !(n.source === 'auto_presented' && n.date === date));
        saveServantNotes(notes);

        if (typeof triggerCloudSync === 'function') triggerCloudSync();
        showToast(`تم حذف سجل يوم ${label} بنجاح!`, 'success');
        refreshSummaryView();
        refreshDashboard();
    }
};

window.editDayAttendance = function (date) {
    document.getElementById('attendance-date').value = date;

    // Switch to Attendance tab
    const navBtns = document.querySelectorAll('.nav-btn');
    const views = document.querySelectorAll('.view-section');

    navBtns.forEach(b => b.classList.remove('active'));
    views.forEach(v => v.classList.remove('active'));

    document.querySelector('[data-target="attendance-view"]').classList.add('active');
    document.getElementById('attendance-view').classList.add('active');

    // Sync mobile bottom nav and save bar
    document.querySelectorAll('.mobile-nav-item[data-target]').forEach(mItem => {
        mItem.classList.toggle('active', mItem.getAttribute('data-target') === 'attendance-view');
    });
    const mobileSaveBar = document.getElementById('attendance-mobile-save-bar');
    if (mobileSaveBar) {
        const canEditAttendance = currentUserRole === 'admin' || currentPermissions.includes('attendance-edit');
        mobileSaveBar.style.display = canEditAttendance ? 'flex' : 'none';
    }

    document.getElementById('btn-start-day').click(); // trigger the load
};

// --- WhatsApp Task Logic ---
function setupWhatsAppTask() {
    const btnOpenWa = document.getElementById('btn-open-wa-task');
    const modalWa = document.getElementById('whatsapp-task-modal-bg');
    const servantSelect = document.getElementById('wa-servant-select');
    const absentListContainer = document.getElementById('wa-absent-members-list');
    const previewArea = document.getElementById('wa-message-preview');
    const btnSendWa = document.getElementById('btn-send-whatsapp');

    if (!btnOpenWa) return;

    btnOpenWa.addEventListener('click', () => {
        if (currentUserRole !== 'admin') {
            alert('عفواً، ميزة تكليف الواتساب خاصة بالأدمن فقط.');
            return;
        }
        const members = getMembers();
        const records = getAttendanceRecords();
        const waTasks = getWaTasks();

        // Find last meeting date and absentees
        const dates = Object.keys(records).sort((a, b) => b.localeCompare(a));
        let lastDate = dates.length > 0 ? dates[0] : null;
        let lastMeetingAttendees = lastDate ? (records[lastDate] || []) : [];

        const currentTasks = lastDate && waTasks[lastDate] ? waTasks[lastDate] : { servants: [], members: [] };

        // Populate Servants Dropdown (including those already assigned this week, but with a checkmark)
        servantSelect.innerHTML = '<option value="">-- اختر الخادم --</option>';
        const servants = members.filter(m => m.role === 'servant').sort((a, b) => a.name.localeCompare(b.name, 'ar'));
        servants.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            const isAssigned = currentTasks.servants.includes(s.id);
            opt.textContent = s.name + (isAssigned ? ' ✅' : '');
            servantSelect.appendChild(opt);
        });

        // Get members who are NOT servants and did NOT attend last meeting
        window.waContext = {
            members,
            currentTasks,
            absentMembers: members.filter(m =>
                m.role !== 'servant' &&
                !lastMeetingAttendees.includes(m.id)
            ).sort((a, b) => a.name.localeCompare(b.name, 'ar'))
        };

        renderAbsentList('');
        updatePreview();
        modalWa.classList.add('active');
    });

    function renderAbsentList(servantId) {
        if (!window.waContext) return;
        const { members, currentTasks, absentMembers } = window.waContext;

        absentListContainer.innerHTML = '';

        if (!servantId) {
            absentListContainer.innerHTML = '<p style="color:var(--text-muted); margin:0;">اختر الخادم أولاً لعرض قائمة المخدومين.</p>';
            return;
        }

        const servant = members.find(m => m.id === servantId);
        if (!servant) return;

        const servantGender = servant.gender || 'male';
        const filteredMembers = absentMembers.filter(m => (m.gender || 'male') === servantGender);

        if (filteredMembers.length === 0) {
            absentListContainer.innerHTML = '<p style="color:var(--text-muted); margin:0;">مفيش حد من نفس النوع غايب الجمعة دي!</p>';
        } else {
            filteredMembers.forEach(m => {
                const label = document.createElement('label');
                label.style.display = 'flex';
                label.style.alignItems = 'center';
                label.style.gap = '10px';
                label.style.cursor = 'pointer';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = m.name;
                cb.className = 'wa-absent-checkbox';
                cb.setAttribute('data-id', m.id);

                const isAssigned = currentTasks.members.includes(m.id);
                const checkmark = isAssigned ? ' ✅ (تم التكليف)' : '';

                label.appendChild(cb);
                label.appendChild(document.createTextNode(m.name + checkmark));

                absentListContainer.appendChild(label);
            });
        }
    }

    // Update preview when servant changes or checkboxes change
    servantSelect.addEventListener('change', (e) => {
        renderAbsentList(e.target.value);
        updatePreview();
    });

    absentListContainer.addEventListener('change', (e) => {
        if (e.target.classList.contains('wa-absent-checkbox')) {
            updatePreview();
        }
    });

    function updatePreview() {
        const servantId = servantSelect.value;
        let servantName = '[اسم الخادم]';
        let isFemale = false;

        if (servantId) {
            const members = getMembers();
            const s = members.find(m => m.id === servantId);
            if (s) {
                servantName = s.name.split(' ')[0]; // Use first name
                if (s.gender === 'female') isFemale = true;
            }
        }

        const selectedCheckboxes = Array.from(document.querySelectorAll('.wa-absent-checkbox:checked'));
        const selectedNames = selectedCheckboxes.map(cb => cb.value);

        let membersText = '[أسماء المخدومين]';
        if (selectedNames.length > 0) {
            membersText = selectedNames.join(' و ');
        }

        let template = '';
        if (isFemale) {
            template = `مساء الخير يا ${servantName} ازيك عاملة ايه ، دورك في الأجتماع فارق جداً وكل حاجه بتعمليها ربنا بيكتبها عنده وبيعوضك عنها اضعاف ، متنسيش الأسبوع ده تفتقدي ${membersText} بالفون او واتساب عشان هما مجوش الجمعة اللي فاتت، وتقوليلنا عملتي ايه معاهم \uD83D\uDE4F\u2728`;
        } else {
            template = `مساء الخير يا ${servantName} ازيك عامل ايه ، دورك في الأجتماع فارق جداً وكل حاجه بتعملها ربنا بيكتبها عنده وبيعوضك عنها اضعاف ، متنساش الأسبوع ده تفتقد ${membersText} بالفون او واتساب عشان هما مجوش الجمعة اللي فاتت، وتقولنا عملت ايه معاهم \uD83D\uDE4F\u2728`;
        }

        previewArea.value = template;
    }

    // Send WhatsApp
    btnSendWa.addEventListener('click', () => {
        if (currentUserRole !== 'admin') {
            alert('عفواً، ميزة تكليف الواتساب خاصة بالأدمن فقط.');
            return;
        }
        const servantId = servantSelect.value;
        if (!servantId) {
            alert('برجاء اختيار الخادم أولاً');
            return;
        }

        const members = getMembers();
        const s = members.find(m => m.id === servantId);

        if (!s || !s.phone) {
            alert('هذا الخادم ليس لديه رقم هاتف مسجل. يرجى تعديل بروفايل الخادم وإضافة الرقم أولاً.');
            return;
        }

        // Format phone number
        let phoneNum = s.phone.trim();
        // If it starts with 01 (Egyptian), add +20
        if (phoneNum.startsWith('01') && phoneNum.length === 11) {
            phoneNum = '2' + phoneNum;
        }

        // Remove spaces or any non-numeric except plus
        phoneNum = phoneNum.replace(/[^\d+]/g, '');

        const text = encodeURIComponent(previewArea.value);
        // Use web.whatsapp.com to bypass the intermediate screen
        const url = `https://web.whatsapp.com/send?phone=${phoneNum}&text=${text}`;

        window.open(url, '_blank');
        modalWa.classList.remove('active');

        // Save task so they don't appear again this week
        const records = getAttendanceRecords();
        const dates = Object.keys(records).sort((a, b) => b.localeCompare(a));
        let lastDate = dates.length > 0 ? dates[0] : null;

        if (lastDate) {
            const waTasks = getWaTasks();
            if (!waTasks[lastDate]) waTasks[lastDate] = { servants: [], members: [] };

            waTasks[lastDate].servants.push(servantId);
            const selectedCheckboxes = Array.from(document.querySelectorAll('.wa-absent-checkbox:checked'));
            const selectedIds = selectedCheckboxes.map(cb => cb.getAttribute('data-id'));
            waTasks[lastDate].members.push(...selectedIds);

            saveWaTasks(waTasks);
        }
    });
}


// --- Authentication Setup ---
function setupAuth() {
    const loginUsername = document.getElementById('login-username');
    const permServantSelect = document.getElementById('perm-servant-select');

    // Populate dropdowns with servants
    const members = getMembers().filter(m => m.role === 'servant').sort((a, b) => a.name.localeCompare(b.name, 'ar'));

    if (loginUsername) {
        loginUsername.innerHTML = `
            <option value="admin">المدير (مدير النظام)</option>
            <option value="supervisor">المشرف</option>
        `;
    }
    if (permServantSelect) {
        permServantSelect.innerHTML = `
            <option value="admin">المدير (Admin)</option>
            <option value="supervisor">المشرف (Supervisor)</option>
        `;
    }

    members.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.innerText = m.name;
        if (loginUsername) loginUsername.appendChild(opt.cloneNode(true));
        if (permServantSelect) permServantSelect.appendChild(opt);
    });

    // --- Password Show/Hide Toggle for Login ---
    const btnToggleLoginPass = document.getElementById('btn-toggle-login-password');
    const loginPassInput = document.getElementById('login-password');
    const loginErrorMsg = document.getElementById('login-error-msg');

    if (btnToggleLoginPass && loginPassInput) {
        btnToggleLoginPass.addEventListener('click', (e) => {
            e.preventDefault();
            const icon = document.getElementById('login-pass-icon');
            if (loginPassInput.type === 'password') {
                loginPassInput.type = 'text';
                if (icon) {
                    icon.classList.remove('ph-eye');
                    icon.classList.add('ph-eye-slash');
                }
                btnToggleLoginPass.title = 'إخفاء كلمة المرور';
            } else {
                loginPassInput.type = 'password';
                if (icon) {
                    icon.classList.remove('ph-eye-slash');
                    icon.classList.add('ph-eye');
                }
                btnToggleLoginPass.title = 'إظهار كلمة المرور';
            }
            loginPassInput.focus();
        });
    }

    if (loginPassInput) {
        loginPassInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const btn = document.getElementById('btn-login');
                if (btn) btn.click();
            }
        });
        loginPassInput.addEventListener('input', () => {
            if (loginErrorMsg) loginErrorMsg.style.display = 'none';
        });
    }

    // --- Password Show/Hide Toggle for Permissions Modal ---
    const btnTogglePermPass = document.getElementById('btn-toggle-perm-password');
    const permPassInputEl = document.getElementById('perm-password');
    if (btnTogglePermPass && permPassInputEl) {
        btnTogglePermPass.addEventListener('click', (e) => {
            e.preventDefault();
            const icon = document.getElementById('perm-pass-icon');
            if (permPassInputEl.type === 'password') {
                permPassInputEl.type = 'text';
                if (icon) {
                    icon.classList.remove('ph-eye');
                    icon.classList.add('ph-eye-slash');
                }
                btnTogglePermPass.title = 'إخفاء كلمة المرور';
            } else {
                permPassInputEl.type = 'password';
                if (icon) {
                    icon.classList.remove('ph-eye-slash');
                    icon.classList.add('ph-eye');
                }
                btnTogglePermPass.title = 'إظهار كلمة المرور';
            }
            permPassInputEl.focus();
        });
    }

    const btnLogin = document.getElementById('btn-login');
    if (btnLogin) {
        btnLogin.addEventListener('click', () => {
            const id = document.getElementById('login-username').value;
            const pass = document.getElementById('login-password').value.trim();
            const authData = getAuthData();

            let isValid = false;
            if (id === 'admin') {
                if (pass === authData.admin.password) isValid = true;
            } else if (id === 'supervisor') {
                if (pass === authData.supervisor.password) isValid = true;
            } else {
                if (authData.servants[id] && authData.servants[id].password === pass) isValid = true;
            }

            if (isValid) {
                if (loginErrorMsg) loginErrorMsg.style.display = 'none';
                localStorage.setItem('church_logged_in_user', id);
                document.getElementById('login-password').value = '';
                checkLoginAndApply();
                showToast('تم تسجيل الدخول بنجاح!');
                if (typeof refreshDashboard === 'function') refreshDashboard();
            } else {
                if (loginErrorMsg) {
                    loginErrorMsg.innerText = '⚠️ كلمة المرور غير صحيحة، يرجى المحاولة مرة أخرى.';
                    loginErrorMsg.style.display = 'block';
                }
                showToast('كلمة المرور غير صحيحة!', 'danger');
                if (loginPassInput) {
                    loginPassInput.focus();
                    loginPassInput.select();
                }
            }
        });
    }

    const performLogout = () => {
        localStorage.removeItem('church_logged_in_user');
        currentUserRole = null;
        currentPermissions = [];
        document.documentElement.classList.remove('is-logged-in');
        document.documentElement.classList.add('is-not-logged-in');
        document.body.classList.add('not-logged-in');

        const sidebar = document.querySelector('.sidebar');
        if (sidebar) sidebar.classList.remove('mobile-open');
        const overlay = document.getElementById('mobile-sidebar-overlay');
        if (overlay) overlay.classList.remove('active');

        const loginModal = document.getElementById('login-modal-bg');
        if (loginModal) loginModal.classList.add('active');

        const passInput = document.getElementById('login-password');
        if (passInput) {
            passInput.value = '';
            passInput.type = 'password';
            const icon = document.getElementById('login-pass-icon');
            if (icon) {
                icon.classList.remove('ph-eye-slash');
                icon.classList.add('ph-eye');
            }
        }
        if (loginErrorMsg) loginErrorMsg.style.display = 'none';

        checkLoginAndApply();
        showToast('تم تسجيل الخروج بنجاح');
    };

    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
        btnLogout.addEventListener('click', performLogout);
    }

    const btnLogoutSettings = document.getElementById('btn-logout-settings');
    if (btnLogoutSettings) {
        btnLogoutSettings.addEventListener('click', performLogout);
    }

    const btnManagePermissions = document.getElementById('btn-manage-permissions');
    if (btnManagePermissions) {
        btnManagePermissions.addEventListener('click', () => {
            if (currentUserRole !== 'admin') {
                alert('عفواً، هذه الصلاحية لمدير النظام فقط.');
                return;
            }
            document.getElementById('permissions-modal-bg').classList.add('active');
            if (permServantSelect) permServantSelect.dispatchEvent(new Event('change'));
        });
    }

    if (permServantSelect) {
        permServantSelect.addEventListener('change', () => {
            const id = permServantSelect.value;
            const authData = getAuthData();
            let data;

            if (id === 'admin') {
                data = authData.admin;
            } else if (id === 'supervisor') {
                data = authData.supervisor;
            } else {
                data = authData.servants[id] || { password: '', permissions: ['dashboard-view'] };
            }

            const permPassInput = document.getElementById('perm-password');
            if (permPassInput) {
                permPassInput.value = '';
                permPassInput.type = 'password';
                const pIcon = document.getElementById('perm-pass-icon');
                if (pIcon) {
                    pIcon.classList.remove('ph-eye-slash');
                    pIcon.classList.add('ph-eye');
                }
                permPassInput.placeholder = data.password ? `اكتب كلمة مرور جديدة لتغييرها...` : 'أدخل كلمة مرور جديدة...';
            }

            const hintEl = document.getElementById('perm-pass-hint');
            if (hintEl) {
                hintEl.innerText = data.password ? `🔑 كلمة المرور الحالية: "${data.password}"` : '⚠️ لا توجد كلمة مرور مسجلة بعد';
            }

            Array.from(document.querySelectorAll('.perm-select')).forEach(sel => {
                const section = sel.getAttribute('data-section');
                const perms = data.permissions || [];
                const hasEditOpt = Boolean(sel.querySelector('option[value="edit"]'));
                if (id === 'admin') {
                    sel.value = hasEditOpt ? 'edit' : 'view';
                } else if (perms.includes(section + '-edit') && hasEditOpt) {
                    sel.value = 'edit';
                } else if (perms.includes(section + '-view')) {
                    sel.value = 'view';
                } else {
                    sel.value = 'none';
                }
            });
        });
    }

    const btnSavePermissions = document.getElementById('btn-save-permissions');
    if (btnSavePermissions) {
        btnSavePermissions.addEventListener('click', () => {
            const id = permServantSelect.value;
            if (!id) return;

            const pass = document.getElementById('perm-password').value.trim();
            const perms = [];
            Array.from(document.querySelectorAll('.perm-select')).forEach(sel => {
                const val = sel.value;
                const sec = sel.getAttribute('data-section');
                if (val === 'view') {
                    perms.push(sec + '-view');
                } else if (val === 'edit') {
                    perms.push(sec + '-view');
                    perms.push(sec + '-edit');
                }
            });

            const authData = getAuthData();

            if (id === 'admin') {
                if (pass) authData.admin.password = pass;
                authData.admin.permissions = [
                    'dashboard-view',
                    'attendance-view', 'attendance-edit',
                    'followup-view', 'followup-edit',
                    'servants-dashboard-view', 'servants-dashboard-edit',
                    'servants-notes-view', 'servants-notes-edit',
                    'competitions-view', 'competitions-edit',
                    'trips-view', 'trips-edit',
                    'summary-view',
                    'admin-view', 'admin-edit',
                    'reports-view',
                    'settings-view'
                ];
            } else if (id === 'supervisor') {
                if (pass) authData.supervisor.password = pass;
                authData.supervisor.permissions = perms;
            } else {
                if (!authData.servants[id]) authData.servants[id] = { role: 'servant', password: '', permissions: [] };
                if (pass) authData.servants[id].password = pass;
                authData.servants[id].permissions = perms;
            }

            saveAuthData(authData);
            if (typeof triggerCloudSync === 'function') triggerCloudSync();
            document.getElementById('permissions-modal-bg').classList.remove('active');
            
            const userLabel = id === 'admin' ? 'المدير' : id === 'supervisor' ? 'المشرف' : 'الخادم';
            showToast(`تم حفظ صلاحيات وكلمة مرور ${userLabel} بنجاح! ✅`, 'success');

            if (localStorage.getItem('church_logged_in_user') === id) {
                checkLoginAndApply();
            }
        });
    }
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    setupNavigation();
    setupModals();
    setupSettings();
    setupAttendanceView();
    setupViewFilters('#followup-view', '#followup-members-grid', 'search-followup');
    setupVisitationModals();
    setupAdminFilters();
    setupPersonModal();
    setupModalDismiss();
    setupSearchListeners();
    setupWhatsAppTask();
    setupCopyNeedsVisit();
    setupKeyboardShortcuts();
    setupCompetitions();
    setupServantsNotes();
    setupTrips();

    setupAuth();
    checkLoginAndApply();

    // Load initial view only if authenticated
    if (localStorage.getItem('church_logged_in_user')) {
        refreshDashboard();
    }
});

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            const ws = document.getElementById('attendance-workspace');
            if (ws && ws.style.display !== 'none') {
                const btnSave = document.getElementById('btn-save-attendance');
                if (btnSave) btnSave.click();
            }
        }
    });
}

// ==========================================
// COMPETITIONS LOGIC
// ==========================================

function getHistoricalMemberPoints() {
    const comps = getCompetitions();
    const attendanceDb = getAttendanceRecords();
    const pointsMap = {};
    const participatedSet = new Set();

    const allMembers = getMembers();
    allMembers.forEach(m => pointsMap[m.id] = 0);

    comps.forEach(comp => {
        const teamStats = {
            team1: { totalPoints: 0 },
            team2: { totalPoints: 0 },
            team3: { totalPoints: 0 }
        };

        comp.rounds.forEach(round => {
            teamStats.team1.totalPoints += (round.results.team1 || 0);
            teamStats.team2.totalPoints += (round.results.team2 || 0);
            teamStats.team3.totalPoints += (round.results.team3 || 0);
        });

        const sortedTeamKeys = ['team1', 'team2', 'team3'].sort((a, b) => teamStats[b].totalPoints - teamStats[a].totalPoints);
        const teamRankPoints = {};
        teamRankPoints[sortedTeamKeys[0]] = 3;
        teamRankPoints[sortedTeamKeys[1]] = 2;
        teamRankPoints[sortedTeamKeys[2]] = 1;

        const compMembers = [
            ...comp.teams.team1.members.map(id => ({ id, teamKey: 'team1' })),
            ...comp.teams.team2.members.map(id => ({ id, teamKey: 'team2' })),
            ...comp.teams.team3.members.map(id => ({ id, teamKey: 'team3' }))
        ];

        compMembers.forEach(m => {
            if (pointsMap[m.id] === undefined) pointsMap[m.id] = 0;
            participatedSet.add(m.id);
            let attendancePoints = 0;
            comp.rounds.forEach(round => {
                const roundAtt = attendanceDb[round.date] || [];
                if (roundAtt.includes(m.id)) {
                    attendancePoints += 1;
                }
            });
            
            // If they didn't attend any round in this competition, they get 0 points total for this comp (no rank points)
            if (attendancePoints > 0) {
                pointsMap[m.id] += teamRankPoints[m.teamKey] + attendancePoints;
            }
        });
    });

    return { pointsMap, participatedSet };
}

function setupCompetitions() {
    const btnCreate = document.getElementById('btn-create-competition');
    if (btnCreate) {
        btnCreate.addEventListener('click', () => {
            document.getElementById('edit-comp-id').value = '';
            document.getElementById('comp-name').value = '';
            document.getElementById('comp-team1-name').value = 'فريق 1';
            document.getElementById('comp-team2-name').value = 'فريق 2';
            document.getElementById('comp-team3-name').value = 'فريق 3';

            // Populate members
            const members = getMembers().sort((a, b) => a.name.localeCompare(b.name, 'ar'));
            const container = document.getElementById('comp-members-selection');
            container.innerHTML = '';

            members.forEach(member => {
                const div = document.createElement('div');
                div.style.display = 'flex';
                div.style.alignItems = 'center';
                div.style.justifyContent = 'space-between';
                div.style.padding = '5px 0';
                div.style.borderBottom = '1px solid rgba(255,255,255,0.05)';

                const roleBadge = member.role === 'servant' ? '<span class="badge-warning" style="font-size: 0.7rem; padding: 2px 5px; border-radius: 4px; margin-right: 5px;">خادم</span>' : '';

                div.innerHTML = '<div style="flex: 2; display: flex; align-items: center;" class="member-name-label">' +
                    '<span style="font-weight: 500;">' + member.name + '</span>' +
                    roleBadge +
                    '</div>' +
                    '<div style="flex: 3; display: flex; gap: 5px;">' +
                    '<select class="form-control comp-team-select" data-id="' + member.id + '" style="padding: 5px; font-size: 0.9rem;">' +
                    '<option value="none">-- غير مشارك --</option>' +
                    '<option value="team1">الفريق 1</option>' +
                    '<option value="team2">الفريق 2</option>' +
                    '<option value="team3">الفريق 3</option>' +
                    '</select>' +
                    '</div>';
                container.appendChild(div);
            });

            document.getElementById('create-competition-modal').classList.add('active');
        });
    }

    const searchMembers = document.getElementById('comp-search-members');
    if (searchMembers) {
        searchMembers.addEventListener('input', (e) => {
            const term = e.target.value.trim().toLowerCase();
            const container = document.getElementById('comp-members-selection');
            Array.from(container.children).forEach(row => {
                const name = row.querySelector('.member-name-label').innerText.toLowerCase();
                row.style.display = name.includes(term) ? 'flex' : 'none';
            });
        });
    }

    let currentSuggestedTeams = null;

    function generateSuggestion() {
        const { pointsMap, participatedSet } = getHistoricalMemberPoints();
        const selects = Array.from(document.querySelectorAll('.comp-team-select'));
        const allMembers = getMembers();
        const memberNameMap = {};
        allMembers.forEach(m => memberNameMap[m.id] = m.name);

        const membersToDistribute = [];
        selects.forEach(sel => {
            const id = sel.getAttribute('data-id');
            if (participatedSet.has(id)) {
                membersToDistribute.push({ id, name: memberNameMap[id] || 'بدون اسم', points: pointsMap[id] || 0 });
            }
        });

        if (membersToDistribute.length === 0) {
            alert('لم يتم العثور على أي أشخاص اشتركوا في مسابقات سابقة.');
            return;
        }

        membersToDistribute.sort((a, b) => b.points - a.points);

        const distributedTeams = { team1: [], team2: [], team3: [] };
        const numTeams = 3;

        for (let i = 0; i < membersToDistribute.length; i += numTeams) {
            const batch = membersToDistribute.slice(i, i + numTeams);
            batch.sort(() => Math.random() - 0.5);
            if (batch[0]) distributedTeams.team1.push(batch[0].id);
            if (batch[1]) distributedTeams.team2.push(batch[1].id);
            if (batch[2]) distributedTeams.team3.push(batch[2].id);
        }

        currentSuggestedTeams = distributedTeams;

        document.getElementById('preview-team1-name').innerText = document.getElementById('comp-team1-name').value.trim() || 'فريق 1';
        document.getElementById('preview-team2-name').innerText = document.getElementById('comp-team2-name').value.trim() || 'فريق 2';
        document.getElementById('preview-team3-name').innerText = document.getElementById('comp-team3-name').value.trim() || 'فريق 3';

        document.getElementById('preview-team1-list').innerHTML = distributedTeams.team1.map(id => '<div style="padding: 4px; border-bottom: 1px solid rgba(255,255,255,0.05);">' + (memberNameMap[id] || '') + '</div>').join('');
        document.getElementById('preview-team2-list').innerHTML = distributedTeams.team2.map(id => '<div style="padding: 4px; border-bottom: 1px solid rgba(255,255,255,0.05);">' + (memberNameMap[id] || '') + '</div>').join('');
        document.getElementById('preview-team3-list').innerHTML = distributedTeams.team3.map(id => '<div style="padding: 4px; border-bottom: 1px solid rgba(255,255,255,0.05);">' + (memberNameMap[id] || '') + '</div>').join('');

        document.getElementById('suggest-distribution-modal').classList.add('active');
    }

    const btnSuggestDist = document.getElementById('btn-suggest-distribution');
    if (btnSuggestDist) {
        btnSuggestDist.addEventListener('click', generateSuggestion);
    }

    const btnReSuggest = document.getElementById('btn-re-suggest');
    if (btnReSuggest) {
        btnReSuggest.addEventListener('click', generateSuggestion);
    }

    const btnApplySuggestion = document.getElementById('btn-apply-suggestion');
    if (btnApplySuggestion) {
        btnApplySuggestion.addEventListener('click', () => {
            if (!currentSuggestedTeams) return;
            const selects = Array.from(document.querySelectorAll('.comp-team-select'));
            selects.forEach(sel => {
                const id = sel.getAttribute('data-id');
                if (currentSuggestedTeams.team1.includes(id)) sel.value = 'team1';
                else if (currentSuggestedTeams.team2.includes(id)) sel.value = 'team2';
                else if (currentSuggestedTeams.team3.includes(id)) sel.value = 'team3';
                else sel.value = 'none';
            });
            document.getElementById('suggest-distribution-modal').classList.remove('active');
            showToast('تم تطبيق المقترح بنجاح!');
        });
    }

    const btnSaveComp = document.getElementById('btn-save-competition');
    if (btnSaveComp) {
        btnSaveComp.addEventListener('click', () => {
            if (currentUserRole !== 'admin' && !currentPermissions.includes('competitions-edit')) {
                alert('عفواً، لا تملك صلاحية إنشاء أو تعديل المسابقة (المشاهدة فقط).');
                return;
            }
            const name = document.getElementById('comp-name').value.trim();
            if (!name) return alert('أدخل اسم المسابقة');

            const t1Name = document.getElementById('comp-team1-name').value.trim() || 'فريق 1';
            const t2Name = document.getElementById('comp-team2-name').value.trim() || 'فريق 2';
            const t3Name = document.getElementById('comp-team3-name').value.trim() || 'فريق 3';

            const selects = document.querySelectorAll('.comp-team-select');
            const team1Members = [];
            const team2Members = [];
            const team3Members = [];

            selects.forEach(sel => {
                const val = sel.value;
                const id = sel.getAttribute('data-id');
                if (val === 'team1') team1Members.push(id);
                if (val === 'team2') team2Members.push(id);
                if (val === 'team3') team3Members.push(id);
            });

            const comps = getCompetitions();
            const editId = document.getElementById('edit-comp-id').value;

            if (editId) {
                const compIndex = comps.findIndex(c => c.id === editId);
                if (compIndex !== -1) {
                    comps[compIndex].name = name;
                    comps[compIndex].teams.team1.name = t1Name;
                    comps[compIndex].teams.team1.members = team1Members;
                    comps[compIndex].teams.team2.name = t2Name;
                    comps[compIndex].teams.team2.members = team2Members;
                    comps[compIndex].teams.team3.name = t3Name;
                    comps[compIndex].teams.team3.members = team3Members;
                    saveCompetitions(comps);
                    showToast('تم تحديث المسابقة بنجاح');
                    openCompetitionDetails(editId); // refresh modal
                }
            } else {
                const newComp = {
                    id: 'comp_' + Date.now(),
                    name: name,
                    status: 'active', // can be 'active' or 'finished'
                    createdAt: todayLocal(),
                    teams: {
                        team1: { name: t1Name, members: team1Members },
                        team2: { name: t2Name, members: team2Members },
                        team3: { name: t3Name, members: team3Members }
                    },
                    rounds: []
                };
                comps.push(newComp);
                saveCompetitions(comps);
                showToast('تم إنشاء المسابقة بنجاح');
            }

            document.getElementById('create-competition-modal').classList.remove('active');
            renderCompetitions();
        });
    }

    const btnEditComp = document.getElementById('btn-edit-comp');
    if (btnEditComp) {
        btnEditComp.addEventListener('click', () => {
            const compId = document.getElementById('current-comp-id').value;
            const comp = getCompetitions().find(c => c.id === compId);
            if (!comp) return;

            // Removed finished block

            // Populate form
            document.getElementById('edit-comp-id').value = comp.id;
            document.getElementById('comp-name').value = comp.name;
            document.getElementById('comp-team1-name').value = comp.teams.team1.name;
            document.getElementById('comp-team2-name').value = comp.teams.team2.name;
            document.getElementById('comp-team3-name').value = comp.teams.team3.name;

            // Re-render members selection
            const members = getMembers().sort((a, b) => a.name.localeCompare(b.name, 'ar'));
            const container = document.getElementById('comp-members-selection');
            container.innerHTML = '';

            members.forEach(member => {
                const div = document.createElement('div');
                div.style.display = 'flex';
                div.style.alignItems = 'center';
                div.style.justifyContent = 'space-between';
                div.style.padding = '5px 0';
                div.style.borderBottom = '1px solid rgba(255,255,255,0.05)';

                const roleBadge = member.role === 'servant' ? '<span class="badge-warning" style="font-size: 0.7rem; padding: 2px 5px; border-radius: 4px; margin-right: 5px;">خادم</span>' : '';

                let selectedTeam = 'none';
                if (comp.teams.team1.members.includes(member.id)) selectedTeam = 'team1';
                else if (comp.teams.team2.members.includes(member.id)) selectedTeam = 'team2';
                else if (comp.teams.team3.members.includes(member.id)) selectedTeam = 'team3';

                div.innerHTML = '<div style="flex: 2; display: flex; align-items: center;" class="member-name-label">' +
                    '<span style="font-weight: 500;">' + member.name + '</span>' +
                    roleBadge +
                    '</div>' +
                    '<div style="flex: 3; display: flex; gap: 5px;">' +
                    '<select class="form-control comp-team-select" data-id="' + member.id + '" style="padding: 5px; font-size: 0.9rem;">' +
                    '<option value="none" ' + (selectedTeam === 'none' ? 'selected' : '') + '>-- غير مشارك --</option>' +
                    '<option value="team1" ' + (selectedTeam === 'team1' ? 'selected' : '') + '>الفريق 1</option>' +
                    '<option value="team2" ' + (selectedTeam === 'team2' ? 'selected' : '') + '>الفريق 2</option>' +
                    '<option value="team3" ' + (selectedTeam === 'team3' ? 'selected' : '') + '>الفريق 3</option>' +
                    '</select>' +
                    '</div>';
                container.appendChild(div);
            });

            // Hide details modal and show create/edit modal
            document.getElementById('competition-details-modal').classList.remove('active');
            document.getElementById('create-competition-modal').classList.add('active');
        });
    }

    const btnAddRound = document.getElementById('btn-add-comp-round');
    if (btnAddRound) {
        btnAddRound.addEventListener('click', () => {
            const compId = document.getElementById('current-comp-id').value;
            const comps = getCompetitions();
            const comp = comps.find(c => c.id === compId);
            if (!comp) return;

            // Removed finished block

            document.getElementById('round-date').value = todayLocal();

            document.getElementById('label-team1-points').innerText = 'نقاط ' + comp.teams.team1.name;
            document.getElementById('label-team2-points').innerText = 'نقاط ' + comp.teams.team2.name;
            document.getElementById('label-team3-points').innerText = 'نقاط ' + comp.teams.team3.name;
            document.getElementById('round-team1-points').value = 0;
            document.getElementById('round-team2-points').value = 0;
            document.getElementById('round-team3-points').value = 0;

            document.getElementById('add-round-modal').classList.add('active');
        });
    }

    const btnSaveRound = document.getElementById('btn-save-round');
    if (btnSaveRound) {
        btnSaveRound.addEventListener('click', () => {
            if (currentUserRole !== 'admin' && !currentPermissions.includes('competitions-edit')) {
                alert('عفواً، لا تملك صلاحية إضافة جولة للمسابقة (المشاهدة فقط).');
                return;
            }
            const compId = document.getElementById('current-comp-id').value;
            const comps = getCompetitions();
            const compIndex = comps.findIndex(c => c.id === compId);
            if (compIndex === -1) return;

            // Removed finished block

            const date = document.getElementById('round-date').value;
            if (!date) return alert('أدخل تاريخ الجولة');

            // Check if round already exists for this date
            if (comps[compIndex].rounds.some(r => r.date === date)) {
                return alert('تم تسجيل جولة في هذا التاريخ مسبقاً لهذه المسابقة');
            }

            const points1 = parseInt(document.getElementById('round-team1-points').value) || 0;
            const points2 = parseInt(document.getElementById('round-team2-points').value) || 0;
            const points3 = parseInt(document.getElementById('round-team3-points').value) || 0;

            const newRound = {
                id: 'round_' + Date.now(),
                date: date,
                results: {
                    team1: points1,
                    team2: points2,
                    team3: points3
                }
            };

            comps[compIndex].rounds.push(newRound);
            saveCompetitions(comps);

            document.getElementById('add-round-modal').classList.remove('active');
            showToast('تم حفظ نتيجة الجولة');
            openCompetitionDetails(compId); // refresh details
            renderCompetitions(); // refresh grid
        });
    }

    const btnDeleteComp = document.getElementById('btn-delete-comp');
    if (btnDeleteComp) {
        btnDeleteComp.addEventListener('click', async () => {
            if (currentUserRole !== 'admin' && !currentPermissions.includes('competitions-edit')) {
                alert('عفواً، لا تملك صلاحية حذف المسابقة (المشاهدة فقط).');
                return;
            }
            const compId = document.getElementById('current-comp-id').value;
            if (!compId) return;

            if (await customConfirm('هل أنت متأكد من حذف المسابقة بالكامل؟ لا يمكن التراجع عن هذا الإجراء.')) {
                const comps = getCompetitions().filter(c => c.id !== compId);
                saveCompetitions(comps);
                document.getElementById('competition-details-modal').classList.remove('active');
                showToast('تم الحذف بنجاح');
                renderCompetitions();
            }
        });
    }

    const btnFinishComp = document.getElementById('btn-finish-comp');
    if (btnFinishComp) {
        btnFinishComp.addEventListener('click', async () => {
            if (currentUserRole !== 'admin' && !currentPermissions.includes('competitions-edit')) {
                alert('عفواً، لا تملك صلاحية إنهاء المسابقة (المشاهدة فقط).');
                return;
            }
            const compId = document.getElementById('current-comp-id').value;
            if (!compId) return;

            const comps = getCompetitions();
            const compIndex = comps.findIndex(c => c.id === compId);
            if (compIndex === -1) return;

            if (comps[compIndex].status === 'finished') {
                return alert('المسابقة منتهية بالفعل.');
            }

            if (await customConfirm('هل أنت متأكد من إنهاء المسابقة نهائياً؟ لن تتمكن من إضافة أو تعديل أي جولات بعد ذلك، وسوف يتم تصدير درجات المتسابقين.')) {
                comps[compIndex].status = 'finished';
                saveCompetitions(comps);
                showToast('تم إنهاء المسابقة وتحميل الدرجات');
                openCompetitionDetails(compId); // refresh details
                renderCompetitions(); // refresh grid

                if (typeof exportCompetitionScores === 'function') {
                    exportCompetitionScores(compId);
                }
            }
        });
    }

    const btnPrintResult = document.getElementById('btn-print-comp-result');
    if (btnPrintResult) {
        btnPrintResult.addEventListener('click', () => {
            if (currentUserRole !== 'admin' && !currentPermissions.includes('reports-view')) {
                alert('عفواً، لا تملك صلاحية طباعة أو استخراج نتائج المسابقة.');
                return;
            }
            const compId = document.getElementById('current-comp-id').value;
            if (!compId) return;
            if (typeof copyCompetitionResultToClipboard === 'function') {
                copyCompetitionResultToClipboard(compId);
            }
        });
    }
}

function renderCompetitions(...args) {
    const res = renderCompetitions_original(...args);
    setTimeout(enforcePermissions, 50);
    return res;
}
function renderCompetitions_original() {
    const container = document.getElementById('competitions-list-container');
    if (!container) return;

    const comps = getCompetitions();
    const countAllSpan = document.getElementById('comp-count-all');
    if (countAllSpan) countAllSpan.textContent = comps.length;

    // Attach filter pill listeners once
    if (!window._compFiltersAttached) {
        window._compFiltersAttached = true;
        document.querySelectorAll('.comp-filter-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.comp-filter-pill').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                window.currentCompFilter = btn.getAttribute('data-filter');
                renderCompetitions();
            });
        });
    }

    if (comps.length === 0) {
        container.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;">' +
            '<i class="ph ph-trophy"></i>' +
            '<h3>لا توجد مسابقات حالياً</h3>' +
            '<p>اضغط على "إضافة مسابقة جديدة" لتبدأ</p>' +
            '</div>';
        return;
    }

    container.innerHTML = '';
    const activeFilter = window.currentCompFilter || 'all';

    const sortedComps = [...comps].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    let renderedCount = 0;

    sortedComps.forEach(comp => {
        const isFinished = comp.status === 'finished';
        if (activeFilter === 'active' && isFinished) return;
        if (activeFilter === 'finished' && !isFinished) return;
        renderedCount++;

        const totalMembers = ((comp.teams?.team1?.members?.length) || 0) + 
                             ((comp.teams?.team2?.members?.length) || 0) + 
                             ((comp.teams?.team3?.members?.length) || 0);
        const roundsCount = comp.rounds ? comp.rounds.length : 0;

        const card = document.createElement('article');
        card.className = `competition-card ${isFinished ? 'is-finished' : 'is-active'}`;
        card.setAttribute('data-comp-id', comp.id);

        card.innerHTML = `
            <div class="comp-status-indicator ${isFinished ? 'status-indicator-finished' : 'status-indicator-active'}"></div>
            <div class="comp-card-header">
                <div class="comp-header-info">
                    <div class="comp-title-row">
                        <h2 class="comp-name">${esc(comp.name)}</h2>
                        ${isFinished ? 
                            `<span class="comp-badge badge-finished">منتهية</span>` : 
                            `<span class="comp-badge badge-running"><span class="badge-dot"></span> جارية</span>`
                        }
                    </div>
                    <p class="comp-created-date">تاريخ الإنشاء: ${esc(comp.createdAt || '--')}</p>
                </div>
                <div class="comp-trophy-box">
                    <i class="ph-fill ph-trophy"></i>
                </div>
            </div>
            <div class="comp-stats-strip">
                <div class="comp-stat-cell">
                    <i class="ph ph-users comp-icon-blue"></i>
                    <span><strong>${totalMembers}</strong> مشترك</span>
                </div>
                <div class="comp-stat-cell">
                    <i class="ph ph-flag comp-icon-gold"></i>
                    <span><strong>${roundsCount}</strong> ${roundsCount === 1 ? 'جولة' : 'جولات'}</span>
                </div>
            </div>
            <div class="comp-actions-row">
                <button class="comp-btn-primary" onclick="openCompetitionDetails('${comp.id}')">
                    <i class="ph ph-chart-bar"></i>
                    <span>${isFinished ? 'عرض النتائج والترتيب النهائي' : 'عرض الترتيب والنتائج'}</span>
                </button>
                <button class="comp-btn-secondary" onclick="event.stopPropagation(); copyCompetitionResultToClipboard('${comp.id}')" title="طباعة النتيجة">
                    <i class="ph ph-printer"></i>
                    <span>طباعة</span>
                </button>
            </div>
        `;

        card.addEventListener('click', () => openCompetitionDetails(comp.id));
        container.appendChild(card);
    });

    if (renderedCount === 0) {
        container.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;">' +
            '<i class="ph ph-funnel"></i>' +
            '<h3>لا توجد مسابقات مطابقة لهذا الفلتر</h3>' +
            '</div>';
    }
}

function openCompetitionDetails(...args) {
    const res = openCompetitionDetails_original(...args);
    setTimeout(enforcePermissions, 50);
    return res;
}
function openCompetitionDetails_original(compId) {
    const comps = getCompetitions();
    const comp = comps.find(c => c.id === compId);
    if (!comp) return;

    document.getElementById('current-comp-id').value = comp.id;

    const statusBadge = document.getElementById('comp-status-badge');
    if (statusBadge) {
        if (comp.status === 'finished') {
            statusBadge.className = 'badge-danger';
            statusBadge.innerText = 'مسابقة منتهية';
            document.getElementById('btn-add-comp-round').style.display = 'inline-flex';
            document.getElementById('btn-finish-comp').style.display = 'none';
        } else {
            statusBadge.className = 'badge-success';
            statusBadge.innerText = 'مسابقة جارية';
            document.getElementById('btn-add-comp-round').style.display = 'inline-flex';
            document.getElementById('btn-finish-comp').style.display = 'inline-flex';
        }
    }

    document.getElementById('comp-details-title').innerHTML = '<i class="ph ph-medal"></i> تفاصيل المسابقة (' + comp.name + ') ' + (statusBadge ? statusBadge.outerHTML : '');

    const allMembers = getMembers();
    const memberMap = {};
    allMembers.forEach(m => memberMap[m.id] = m.name);

    const attendanceDb = getAttendanceRecords();

    // Calculate stats
    const teamStats = {
        team1: { name: comp.teams.team1.name, totalPoints: 0, membersList: comp.teams.team1.members },
        team2: { name: comp.teams.team2.name, totalPoints: 0, membersList: comp.teams.team2.members },
        team3: { name: comp.teams.team3.name, totalPoints: 0, membersList: comp.teams.team3.members }
    };

    const individualStats = [];

    const compMembers = [
        ...comp.teams.team1.members.map(id => ({ id: id, teamKey: 'team1' })),
        ...comp.teams.team2.members.map(id => ({ id: id, teamKey: 'team2' })),
        ...comp.teams.team3.members.map(id => ({ id: id, teamKey: 'team3' }))
    ];

    // Calculate total team points from rounds
    comp.rounds.forEach(round => {
        teamStats.team1.totalPoints += (round.results.team1 || 0);
        teamStats.team2.totalPoints += (round.results.team2 || 0);
        teamStats.team3.totalPoints += (round.results.team3 || 0);
    });

    // Rank teams based on their total points
    const sortedTeamKeys = ['team1', 'team2', 'team3'].sort((a, b) => teamStats[b].totalPoints - teamStats[a].totalPoints);
    const teamRankPoints = {};
    teamRankPoints[sortedTeamKeys[0]] = 3; // 1st Place
    teamRankPoints[sortedTeamKeys[1]] = 2; // 2nd Place
    teamRankPoints[sortedTeamKeys[2]] = 1; // 3rd Place

    compMembers.forEach(m => {
        let attendancePoints = 0;

        comp.rounds.forEach(round => {
            const roundAtt = attendanceDb[round.date] || [];
            if (roundAtt.includes(m.id)) {
                attendancePoints += 1;
            }
        });

        const memberTeamPoints = teamRankPoints[m.teamKey];
        const totalPoints = memberTeamPoints + attendancePoints;

        individualStats.push({
            id: m.id,
            name: memberMap[m.id] || 'عضو محذوف',
            teamName: teamStats[m.teamKey].name,
            teamKey: m.teamKey,
            teamPoints: memberTeamPoints,
            attendancePoints: attendancePoints,
            totalPoints: totalPoints
        });
    });

    // Render Team Summary
    const sortedTeams = Object.values(teamStats).sort((a, b) => b.totalPoints - a.totalPoints);
    const summaryContainer = document.getElementById('comp-teams-summary');
    summaryContainer.innerHTML = '';

    sortedTeams.forEach((ts, index) => {
        const medalColor = index === 0 ? 'gold' : index === 1 ? 'silver' : '#cd7f32';
        summaryContainer.innerHTML += '<div class="stat-card glass" style="padding: 15px; display: flex; flex-direction: column; align-items: center; border: 1px solid ' + medalColor + ';">' +
            '<i class="ph ph-medal" style="font-size: 2.5rem; color: ' + medalColor + ';"></i>' +
            '<h3 style="margin-top: 10px; font-size: 1.2rem;">' + ts.name + '</h3>' +
            '<p style="font-size: 1.5rem; font-weight: bold; margin-top: 5px;">' + ts.totalPoints + ' <span style="font-size: 0.9rem; font-weight: normal; color: var(--text-muted);">نقطة كلي</span></p>' +
            '<p style="font-size: 0.8rem; color: var(--text-muted);">' + ts.membersList.length + ' مشترك</p>' +
            '</div>';
    });

    // Render Leaderboard
    individualStats.sort((a, b) => b.totalPoints - a.totalPoints);
    const tbody = document.getElementById('comp-leaderboard-body');
    tbody.innerHTML = '';

    individualStats.forEach((ind, index) => {
        let rankHtml = '<b>' + (index + 1) + '</b>';
        if (index === 0) rankHtml = '<i class="ph ph-medal" style="color: gold; font-size: 1.2rem;"></i> 1';
        else if (index === 1) rankHtml = '<i class="ph ph-medal" style="color: silver; font-size: 1.2rem;"></i> 2';
        else if (index === 2) rankHtml = '<i class="ph ph-medal" style="color: #cd7f32; font-size: 1.2rem;"></i> 3';

        let rowStyle = '';
        if (index < 3) rowStyle = 'background: rgba(255, 215, 0, 0.05);';

        tbody.innerHTML += '<tr style="' + rowStyle + '">' +
            '<td>' + rankHtml + '</td>' +
            '<td style="font-weight: 500;">' + ind.name + '</td>' +
            '<td><span class="badge-warning" style="background: rgba(99, 102, 241, 0.2); color: #818cf8;">' + ind.teamName + '</span></td>' +
            '<td>' + ind.teamPoints + '</td>' +
            '<td><span style="color: var(--success); font-weight: bold;">+' + ind.attendancePoints + '</span></td>' +
            '<td style="font-weight: bold; font-size: 1.1rem; color: var(--primary);">' + ind.totalPoints + '</td>' +
            '</tr>';
    });

    // Render Rounds List
    const roundsList = document.getElementById('comp-rounds-list');
    roundsList.innerHTML = '';

    if (comp.rounds.length === 0) {
        roundsList.innerHTML = '<p style="color: var(--text-muted); text-align: center;">لا توجد جولات مسجلة بعد.</p>';
    } else {
        const canEditComp = currentUserRole === 'admin' || currentPermissions.includes('competitions-edit');
        const sortedRounds = [...comp.rounds].sort((a, b) => new Date(b.date) - new Date(a.date));
        sortedRounds.forEach((round, index) => {
            const delBtn = canEditComp ? '<button class="btn btn-outline" style="padding: 5px 10px; font-size: 0.8rem; border-color: var(--danger); color: var(--danger);" onclick="deleteCompRound(\'' + comp.id + '\', \'' + round.id + '\')"><i class="ph ph-trash"></i> حذف</button>' : '';

            roundsList.innerHTML += '<div class="glass" style="padding: 10px 15px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border-right: 4px solid var(--primary); margin-top: 5px;">' +
                '<div>' +
                '<strong>جولة ' + round.date + '</strong>' +
                '<div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 5px;">' +
                '<span style="color: var(--primary);">' + comp.teams['team1'].name + ': ' + (round.results['team1'] || 0) + ' نقطة</span> | ' +
                '<span style="color: var(--primary);">' + comp.teams['team2'].name + ': ' + (round.results['team2'] || 0) + ' نقطة</span> | ' +
                '<span style="color: var(--primary);">' + comp.teams['team3'].name + ': ' + (round.results['team3'] || 0) + ' نقطة</span>' +
                '</div>' +
                '</div>' +
                delBtn +
                '</div>';
        });
    }

    document.getElementById('competition-details-modal').classList.add('active');
}

window.deleteCompRound = async function (compId, roundId) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('competitions-edit')) {
        alert('عفواً، لا تملك صلاحية تعديل أو حذف جولات المسابقة.');
        return;
    }
    if (await customConfirm('هل أنت متأكد من حذف نتيجة هذه الجولة؟ سيعاد حساب الدرجات.')) {
        const comps = getCompetitions();
        const comp = comps.find(c => c.id === compId);
        if (comp) {
            comp.rounds = comp.rounds.filter(r => r.id !== roundId);
            saveCompetitions(comps);
            showToast('تم حذف الجولة وإعادة حساب الدرجات');
            openCompetitionDetails(compId); // refresh
        }
    }
};

// Note: Competitions view rendering is handled automatically in navigateToView

window.exportCompetitionScores = function (compId) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('reports-view')) {
        alert('عفواً، لا تملك صلاحية تصدير نتائج المسابقات.');
        return;
    }
    if (typeof XLSX === 'undefined') {
        alert('مكتبة التصدير غير موجودة');
        return;
    }
    const comps = getCompetitions();
    const comp = comps.find(c => c.id === compId);
    if (!comp) return;

    const allMembers = getMembers();
    const memberMap = {};
    allMembers.forEach(m => memberMap[m.id] = m.name);

    const attendanceDb = getAttendanceRecords();

    const individualStats = [];
    const compMembers = [
        ...comp.teams.team1.members.map(id => ({ id: id, teamKey: 'team1', teamName: comp.teams.team1.name })),
        ...comp.teams.team2.members.map(id => ({ id: id, teamKey: 'team2', teamName: comp.teams.team2.name })),
        ...comp.teams.team3.members.map(id => ({ id: id, teamKey: 'team3', teamName: comp.teams.team3.name }))
    ];

    // Calculate total team points from rounds
    const exportTeamStats = {
        team1: { totalPoints: 0 },
        team2: { totalPoints: 0 },
        team3: { totalPoints: 0 }
    };
    comp.rounds.forEach(round => {
        exportTeamStats.team1.totalPoints += (round.results.team1 || 0);
        exportTeamStats.team2.totalPoints += (round.results.team2 || 0);
        exportTeamStats.team3.totalPoints += (round.results.team3 || 0);
    });

    // Rank teams based on their total points
    const exportSortedTeamKeys = ['team1', 'team2', 'team3'].sort((a, b) => exportTeamStats[b].totalPoints - exportTeamStats[a].totalPoints);
    const exportTeamRankPoints = {};
    exportTeamRankPoints[exportSortedTeamKeys[0]] = 3;
    exportTeamRankPoints[exportSortedTeamKeys[1]] = 2;
    exportTeamRankPoints[exportSortedTeamKeys[2]] = 1;

    compMembers.forEach(m => {
        let attendancePoints = 0;

        comp.rounds.forEach(round => {
            const roundAtt = attendanceDb[round.date] || [];
            if (roundAtt.includes(m.id)) {
                attendancePoints += 1;
            }
        });

        const memberTeamPoints = exportTeamRankPoints[m.teamKey];

        individualStats.push({
            'الاسم': memberMap[m.id] || 'عضو محذوف',
            'الفريق': m.teamName,
            'نقاط الفريق': memberTeamPoints,
            'نقاط الحضور': attendancePoints,
            'المجموع الكلي': memberTeamPoints + attendancePoints
        });
    });

    individualStats.sort((a, b) => b['المجموع الكلي'] - a['المجموع الكلي']);
    individualStats.forEach((ind, i) => {
        ind['الترتيب'] = i + 1;
    });

    const finalData = individualStats.map(item => ({
        'الترتيب': item['الترتيب'],
        'الاسم': item['الاسم'],
        'الفريق': item['الفريق'],
        'نقاط الجولات': item['نقاط الفريق'],
        'نقاط الحضور': item['نقاط الحضور'],
        'المجموع الكلي': item['المجموع الكلي']
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(finalData);
    XLSX.utils.book_append_sheet(wb, ws, "نتائج المسابقة");
    XLSX.writeFile(wb, comp.name + " - النتائج النهائية.xlsx");
};

window.copyCompetitionResultToClipboard = function (compId) {
    const comps = getCompetitions();
    const comp = comps.find(c => c.id === compId);
    if (!comp) return;

    const allMembers = getMembers();
    const memberMap = {};
    allMembers.forEach(m => memberMap[m.id] = m.name);

    const attendanceDb = getAttendanceRecords();

    const individualStats = [];
    const compMembers = [
        ...comp.teams.team1.members.map(id => ({ id: id, teamKey: 'team1' })),
        ...comp.teams.team2.members.map(id => ({ id: id, teamKey: 'team2' })),
        ...comp.teams.team3.members.map(id => ({ id: id, teamKey: 'team3' }))
    ];

    const exportTeamStats = {
        team1: { totalPoints: 0 },
        team2: { totalPoints: 0 },
        team3: { totalPoints: 0 }
    };
    comp.rounds.forEach(round => {
        exportTeamStats.team1.totalPoints += (round.results.team1 || 0);
        exportTeamStats.team2.totalPoints += (round.results.team2 || 0);
        exportTeamStats.team3.totalPoints += (round.results.team3 || 0);
    });

    const exportSortedTeamKeys = ['team1', 'team2', 'team3'].sort((a, b) => exportTeamStats[b].totalPoints - exportTeamStats[a].totalPoints);
    const exportTeamRankPoints = {};
    exportTeamRankPoints[exportSortedTeamKeys[0]] = 3;
    exportTeamRankPoints[exportSortedTeamKeys[1]] = 2;
    exportTeamRankPoints[exportSortedTeamKeys[2]] = 1;

    compMembers.forEach(m => {
        let attendancePoints = 0;
        comp.rounds.forEach(round => {
            const roundAtt = attendanceDb[round.date] || [];
            if (roundAtt.includes(m.id)) {
                attendancePoints += 1;
            }
        });

        individualStats.push({
            name: memberMap[m.id] || 'عضو محذوف',
            totalPoints: exportTeamRankPoints[m.teamKey] + attendancePoints
        });
    });

    individualStats.sort((a, b) => b.totalPoints - a.totalPoints);

    let textToCopy = "نتائج " + comp.name + ":\n\n";
    individualStats.forEach((ind, i) => {
        textToCopy += (i + 1) + "- " + ind.name + " (" + ind.totalPoints + ")\n";
    });

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(textToCopy).then(() => {
            showToast('تم نسخ النتيجة بنجاح!');
        }).catch(err => {
            alert('حدث خطأ أثناء النسخ. برجاء المحاولة مرة أخرى.');
        });
    } else {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = textToCopy;
        textarea.style.position = 'fixed'; // Avoid scrolling to bottom
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            showToast('تم نسخ النتيجة بنجاح!');
        } catch (err) {
            alert('حدث خطأ أثناء النسخ.');
        }
        document.body.removeChild(textarea);
    }
};

// --- Mobile UI Responsiveness ---
function toggleMobileMenu() {
    if (!localStorage.getItem('church_logged_in_user')) return;
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('mobile-sidebar-overlay');
    if (sidebar) sidebar.classList.toggle('mobile-open');
    if (overlay) overlay.classList.toggle('active');
}

// --- Permissions Enforcement Patch ---
(function() {
    if (typeof enforcePermissions !== 'function') return;

    function wrapWithEnforce(fnName) {
        const orig = window[fnName] || (typeof eval !== 'undefined' ? (function() { try { return eval(fnName); } catch(e) { return null; } })() : null);
        if (typeof orig === 'function') {
            window[fnName] = function(...args) {
                const res = orig.apply(this, args);
                try { enforcePermissions(); } catch(e) { console.error('enforcePermissions error in ' + fnName, e); }
                return res;
            };
        }
    }

    const functionsToProtect = [
        'refreshDashboard',
        'updateAttendanceWorkspace',
        'refreshFollowUp',
        'refreshServantsDashboard',
        'refreshServantsNotes',
        'renderCompetitions',
        'refreshTripsView',
        'refreshSummaryView',
        'setupAdminTable',
        'refreshAdminView',
        'renderServantsNotesGrid',
        'openMemberProfile'
    ];

    functionsToProtect.forEach(wrapWithEnforce);
})();

// ==========================================
// TRIPS & CONFERENCES LOGIC (الرحلات والمؤتمرات)
// ==========================================

let selectedTripId = null;
let currentBookingFilter = 'all';
let currentBookingSearch = '';
let tripsActiveViewMode = 'single'; // 'single' | 'overview'

function setupTrips() {
    // 1. Hero / Header Add Trip buttons
    const btnCreateTrip = document.getElementById('btn-create-trip');
    if (btnCreateTrip) {
        btnCreateTrip.addEventListener('click', () => openTripModal());
    }

    const btnCreateTripEmpty = document.getElementById('btn-create-trip-empty');
    if (btnCreateTripEmpty) {
        btnCreateTripEmpty.addEventListener('click', () => openTripModal());
    }

    // 2. Edit & Delete active trip buttons
    const btnEditTrip = document.getElementById('btn-edit-trip');
    if (btnEditTrip) {
        btnEditTrip.addEventListener('click', () => {
            if (!selectedTripId) return;
            openTripModal(selectedTripId);
        });
    }

    const btnDeleteTrip = document.getElementById('btn-delete-trip');
    if (btnDeleteTrip) {
        btnDeleteTrip.addEventListener('click', () => {
            if (!selectedTripId) return;
            deleteTrip(selectedTripId);
        });
    }

    // Trips View Mode Buttons (Single Trip File vs All Trips Comparison Grid)
    const btnModeSingle = document.getElementById('btn-mode-single-trip');
    const btnModeAll = document.getElementById('btn-mode-all-trips');
    const btnBackToActive = document.getElementById('btn-back-to-active-trip');

    if (btnModeSingle) {
        btnModeSingle.addEventListener('click', () => {
            tripsActiveViewMode = 'single';
            updateTripsViewModeDisplay();
        });
    }
    if (btnModeAll) {
        btnModeAll.addEventListener('click', () => {
            tripsActiveViewMode = 'overview';
            updateTripsViewModeDisplay();
        });
    }
    if (btnBackToActive) {
        btnBackToActive.addEventListener('click', () => {
            tripsActiveViewMode = 'single';
            updateTripsViewModeDisplay();
        });
    }

    // 3. Save Trip in Modal
    const btnSaveTrip = document.getElementById('btn-save-trip');
    if (btnSaveTrip) {
        btnSaveTrip.addEventListener('click', saveTripData);
    }

    // 4. Add Booking button
    const btnAddBooking = document.getElementById('btn-add-booking');
    if (btnAddBooking) {
        btnAddBooking.addEventListener('click', () => openBookingModal());
    }

    // 5. Booking Modal: Member selector and type pills
    const bookingTypePills = document.querySelectorAll('.booking-type-pill');
    bookingTypePills.forEach(pill => {
        pill.addEventListener('click', () => {
            bookingTypePills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            const radio = pill.querySelector('input[type="radio"]');
            if (radio) {
                radio.checked = true;
                populateBookingMemberSelect(radio.value);
            }
        });
    });

    const bookingMemberSelect = document.getElementById('booking-member-select');
    if (bookingMemberSelect) {
        bookingMemberSelect.addEventListener('change', () => {
            const memberId = bookingMemberSelect.value;
            if (!memberId) return;
            const members = getMembers();
            const member = members.find(m => String(m.id) === String(memberId));
            if (member) {
                const nameInput = document.getElementById('booking-input-name');
                const phoneInput = document.getElementById('booking-input-phone');
                if (nameInput) nameInput.value = member.name || '';
                if (phoneInput) phoneInput.value = member.phone || '';
            }
        });
    }

    // Live remaining calculation in booking modal
    const bookingPriceInput = document.getElementById('booking-input-price');
    const bookingPaidInput = document.getElementById('booking-input-paid');
    const updateBookingCalc = () => {
        const price = Math.max(0, parseFloat(bookingPriceInput ? bookingPriceInput.value : 0) || 0);
        const paid = Math.max(0, parseFloat(bookingPaidInput ? bookingPaidInput.value : 0) || 0);
        const remaining = Math.max(0, price - paid);
        
        const remainingEl = document.getElementById('booking-calc-remaining');
        const statusEl = document.getElementById('booking-calc-status');
        if (remainingEl) remainingEl.textContent = `${remaining.toLocaleString()} ج.م`;

        if (statusEl) {
            if (price === 0 && paid === 0) {
                statusEl.textContent = 'أدخل السعر';
                statusEl.className = 'calc-status-badge';
            } else if (remaining === 0 && paid > 0) {
                statusEl.textContent = 'خالص بالكامل 🟢';
                statusEl.className = 'calc-status-badge text-emerald';
            } else if (paid > 0 && remaining > 0) {
                statusEl.textContent = `فاضل ${remaining.toLocaleString()} ج.م 🟡`;
                statusEl.className = 'calc-status-badge text-amber';
            } else {
                statusEl.textContent = 'لم يسدد بعد 🔴';
                statusEl.className = 'calc-status-badge text-danger';
            }
        }
    };
    if (bookingPriceInput) bookingPriceInput.addEventListener('input', updateBookingCalc);
    if (bookingPaidInput) bookingPaidInput.addEventListener('input', updateBookingCalc);

    // Save Booking button
    const btnSaveBooking = document.getElementById('btn-save-booking');
    if (btnSaveBooking) {
        btnSaveBooking.addEventListener('click', saveBookingData);
    }

    // Quick Pay Modal inputs & confirm button
    const quickPayInput = document.getElementById('quick-pay-input-amount');
    if (quickPayInput) {
        quickPayInput.addEventListener('input', () => {
            const bookingId = document.getElementById('quick-pay-booking-id')?.value;
            if (!bookingId || !selectedTripId) return;
            const trip = getTrips().find(t => t.id === selectedTripId);
            const b = trip?.bookings?.find(item => item.id === bookingId);
            if (!b) return;
            const currentRemaining = Math.max(0, (Number(b.price) || 0) - (Number(b.paid) || 0));
            const payingNow = Math.max(0, parseFloat(quickPayInput.value) || 0);
            const newRemaining = currentRemaining - payingNow;
            const newRemainingEl = document.getElementById('quick-pay-new-remaining');
            const titleEl = document.getElementById('quick-pay-calc-title');
            if (newRemainingEl) {
                if (newRemaining < 0) {
                    if (titleEl) titleEl.textContent = 'زيادة مدفوعة (فائض):';
                    newRemainingEl.className = 'text-amber';
                    newRemainingEl.textContent = `+${Math.abs(newRemaining).toLocaleString()} ج.م`;
                } else if (newRemaining === 0) {
                    if (titleEl) titleEl.textContent = 'المتبقي بعد هذا القسط:';
                    newRemainingEl.className = 'text-emerald';
                    newRemainingEl.textContent = '0 ج.م (خالص بالكامل 🎉)';
                } else {
                    if (titleEl) titleEl.textContent = 'المتبقي بعد هذا القسط:';
                    newRemainingEl.className = 'text-emerald';
                    newRemainingEl.textContent = `${newRemaining.toLocaleString()} ج.م (متبقي أقساط أخرى)`;
                }
            }
        });
    }

    const btnSaveQuickPay = document.getElementById('btn-save-quick-pay');
    if (btnSaveQuickPay) {
        btnSaveQuickPay.addEventListener('click', saveQuickPayment);
    }

    // Search filter input
    const searchInput = document.getElementById('trip-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            currentBookingSearch = e.target.value.trim();
            renderBookingsList();
        });
    }

    // Filter pills
    const filterPills = document.querySelectorAll('#booking-filter-pills .trip-filter-pill');
    filterPills.forEach(pill => {
        pill.addEventListener('click', () => {
            filterPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentBookingFilter = pill.getAttribute('data-filter') || 'all';
            renderBookingsList();
        });
    });

    // Export to Excel button
    const btnExportExcel = document.getElementById('btn-export-trip-excel');
    if (btnExportExcel) {
        btnExportExcel.addEventListener('click', exportTripToExcel);
    }

    // Print Trip Sheet button
    const btnPrintTrip = document.getElementById('btn-print-trip');
    if (btnPrintTrip) {
        btnPrintTrip.addEventListener('click', printTripReport);
    }

    // Delegated actions on bookings table & mobile cards
    const bookingsTableBody = document.getElementById('trip-bookings-tbody');
    if (bookingsTableBody) {
        bookingsTableBody.addEventListener('click', handleBookingActionClick);
    }
    const mobileCardsContainer = document.getElementById('trip-bookings-mobile-cards');
    if (mobileCardsContainer) {
        mobileCardsContainer.addEventListener('click', handleBookingActionClick);
    }
}

function updateTripsViewModeDisplay() {
    const singleContainer = document.getElementById('trip-details-container');
    const overviewContainer = document.getElementById('all-trips-overview-container');
    const btnModeSingle = document.getElementById('btn-mode-single-trip');
    const btnModeAll = document.getElementById('btn-mode-all-trips');

    if (tripsActiveViewMode === 'overview') {
        if (singleContainer) singleContainer.style.display = 'none';
        if (overviewContainer) overviewContainer.style.display = 'block';
        if (btnModeSingle) btnModeSingle.classList.remove('active');
        if (btnModeAll) btnModeAll.classList.add('active');
        renderAllTripsOverviewCards(getTrips());
    } else {
        if (singleContainer) singleContainer.style.display = 'block';
        if (overviewContainer) overviewContainer.style.display = 'none';
        if (btnModeSingle) btnModeSingle.classList.add('active');
        if (btnModeAll) btnModeAll.classList.remove('active');
    }
}

function renderAllTripsOverviewCards(trips) {
    const grid = document.getElementById('all-trips-cards-grid');
    if (!grid) return;

    if (!trips || trips.length === 0) {
        grid.innerHTML = '<p class="text-muted" style="grid-column: 1/-1; text-align: center; padding: 30px;">لا توجد رحلات أو مؤتمرات مسجلة بعد.</p>';
        return;
    }

    grid.innerHTML = trips.map(t => {
        const bookings = t.bookings || [];
        const totalExpected = bookings.reduce((sum, b) => sum + (Number(b.price) || 0), 0);
        const totalCollected = bookings.reduce((sum, b) => sum + (Number(b.paid) || 0), 0);
        const totalRemaining = Math.max(0, totalExpected - totalCollected);
        const percent = totalExpected > 0 ? Math.round((totalCollected / totalExpected) * 100) : (bookings.length > 0 ? 100 : 0);
        const servantsCount = bookings.filter(b => b.type === 'servant').length;
        const membersCount = bookings.filter(b => b.type === 'member').length;
        const isCurrent = t.id === selectedTripId;
        const isCompleted = t.status === 'completed';

        let dateDisplay = t.date ? formatDate(t.date) : '--';
        if (t.endDate && t.endDate !== t.date) {
            dateDisplay += ` إلى ${formatDate(t.endDate)}`;
        }

        return `
            <div class="all-trip-independent-card ${isCurrent ? 'is-active-trip' : ''}">
                <div class="atic-top">
                    <div class="atic-heading">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                            <span class="trip-status-badge ${isCompleted ? 'completed' : ''}">
                                ${isCompleted ? 'منتهية (أرشيف)' : 'جارية (حالية)'}
                            </span>
                            ${isCurrent ? '<span style="font-size: 0.72rem; color: #38bdf8; font-weight: 700; background: rgba(56, 189, 248, 0.15); padding: 2px 8px; border-radius: 8px;"><i class="ph ph-check"></i> الرحلة المحددة حالياً</span>' : ''}
                        </div>
                        <h3 class="atic-title">${esc(t.title)}</h3>
                        <div class="atic-meta-row">
                            <span><i class="ph ph-map-pin"></i> ${esc(t.destination || '--')}</span>
                            <span><i class="ph ph-tag"></i> <strong>${(Number(t.price) || 0).toLocaleString()} ج.م</strong> للفرد</span>
                            <span><i class="ph ph-calendar"></i> ${dateDisplay}</span>
                        </div>
                    </div>
                </div>

                <!-- 3 Independent KPI Ledger Boxes -->
                <div class="atic-ledger">
                    <div class="atic-ledger-box">
                        <span class="atic-ledger-label">إجمالي المطلوب</span>
                        <span class="atic-ledger-amount blue">${totalExpected.toLocaleString()}</span>
                        <span class="atic-ledger-currency">ج.م</span>
                    </div>
                    <div class="atic-ledger-box">
                        <span class="atic-ledger-label">المحصل (اتلم)</span>
                        <span class="atic-ledger-amount emerald">${totalCollected.toLocaleString()}</span>
                        <span class="atic-ledger-currency">ج.م</span>
                    </div>
                    <div class="atic-ledger-box">
                        <span class="atic-ledger-label">المطلوب (فاضل)</span>
                        <span class="atic-ledger-amount amber">${totalRemaining.toLocaleString()}</span>
                        <span class="atic-ledger-currency">ج.م</span>
                    </div>
                </div>

                <!-- Progress & Participants -->
                <div class="atic-progress-wrap">
                    <div class="atic-progress-info">
                        <span>نسبة التحصيل المستقلة: <strong>${percent}%</strong></span>
                        <span>${bookings.length} مشترك (${servantsCount} خادم • ${membersCount} مخدوم)</span>
                    </div>
                    <div class="atic-progress-bar-track">
                        <div class="atic-progress-bar-fill" style="width: ${Math.min(100, percent)}%;"></div>
                    </div>
                </div>

                <!-- Card Actions -->
                <div class="atic-actions">
                    <button class="btn ${isCurrent ? 'btn-primary' : 'btn-outline'} btn-sm" onclick="selectTripAndFocus('${t.id}')">
                        <i class="ph ph-folder-open"></i> فتح حسابات وكشف الرحلة
                    </button>
                    <button class="btn btn-outline btn-sm" onclick="quickAddBookingForTrip('${t.id}')" title="إضافة حجز مباشر لهذه الرحلة">
                        <i class="ph ph-user-plus"></i> حجز
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function selectTripAndFocus(tripId) {
    selectedTripId = tripId;
    tripsActiveViewMode = 'single';
    refreshTripsView();
}
window.selectTripAndFocus = selectTripAndFocus;

function quickAddBookingForTrip(tripId) {
    selectedTripId = tripId;
    tripsActiveViewMode = 'single';
    refreshTripsView();
    openBookingModal();
}
window.quickAddBookingForTrip = quickAddBookingForTrip;

function handleBookingActionClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const bookingId = btn.getAttribute('data-booking-id');
    if (!bookingId) return;

    if (action === 'quick-pay') {
        openQuickPayModal(bookingId);
    } else if (action === 'edit-booking') {
        openBookingModal(bookingId);
    } else if (action === 'delete-booking') {
        deleteBooking(bookingId);
    }
}

function refreshTripsView() {
    const trips = getTrips();
    const noTripsEl = document.getElementById('no-trips-empty-state');
    const detailsContainer = document.getElementById('trip-details-container');
    const overviewContainer = document.getElementById('all-trips-overview-container');
    const selectorBar = document.getElementById('trips-selector-bar');
    const modeBar = document.getElementById('trips-view-mode-bar');

    if (!trips || trips.length === 0) {
        if (noTripsEl) noTripsEl.style.display = 'block';
        if (detailsContainer) detailsContainer.style.display = 'none';
        if (overviewContainer) overviewContainer.style.display = 'none';
        if (selectorBar) selectorBar.style.display = 'none';
        if (modeBar) modeBar.style.display = 'none';
        return;
    }

    if (noTripsEl) noTripsEl.style.display = 'none';
    if (selectorBar) selectorBar.style.display = 'block';
    if (modeBar) modeBar.style.display = 'flex';

    // Verify or select active trip
    if (!selectedTripId || !trips.some(t => t.id === selectedTripId)) {
        selectedTripId = trips[0].id;
    }

    // Render Selector Pills with Independent Financial Tags
    const pillsContainer = document.getElementById('trips-pills-container');
    if (pillsContainer) {
        pillsContainer.innerHTML = '';
        trips.forEach(t => {
            const tBookings = t.bookings || [];
            const tTotal = tBookings.reduce((sum, b) => sum + (Number(b.price) || 0), 0);
            const tCollected = tBookings.reduce((sum, b) => sum + (Number(b.paid) || 0), 0);
            const tRemaining = Math.max(0, tTotal - tCollected);

            const btn = document.createElement('button');
            btn.className = `trip-pill-btn ${t.id === selectedTripId ? 'active' : ''}`;
            btn.setAttribute('data-trip-id', t.id);
            btn.innerHTML = `
                <div class="trip-pill-btn-content">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <i class="ph ph-compass"></i>
                        <span class="trip-pill-title">${esc(t.title)}</span>
                        <span class="trip-pill-badge">${tBookings.length}</span>
                    </div>
                    <div class="trip-pill-fin-summary">
                        <span class="trip-pill-fin-collected">محصل: ${tCollected.toLocaleString()} ج.م</span>
                        <span>|</span>
                        <span class="trip-pill-fin-remaining">فاضل: ${tRemaining.toLocaleString()} ج.م</span>
                    </div>
                </div>
            `;
            btn.addEventListener('click', () => {
                selectedTripId = t.id;
                tripsActiveViewMode = 'single';
                refreshTripsView();
            });
            pillsContainer.appendChild(btn);
        });
    }

    const currentTrip = trips.find(t => t.id === selectedTripId) || trips[0];
    if (!currentTrip) return;

    // Update Mode Bar Labels
    const modeActiveTripName = document.getElementById('mode-active-trip-name');
    if (modeActiveTripName) modeActiveTripName.textContent = currentTrip.title || '--';
    const modeAllTripsCount = document.getElementById('mode-all-trips-count');
    if (modeAllTripsCount) modeAllTripsCount.textContent = trips.length;

    // Render Trip Meta Card
    const nameEl = document.getElementById('trip-detail-name');
    const destEl = document.getElementById('trip-detail-destination');
    const priceEl = document.getElementById('trip-detail-price');
    const dateEl = document.getElementById('trip-detail-date');
    const notesEl = document.getElementById('trip-detail-notes');
    const statusBadge = document.getElementById('trip-status-badge');

    if (nameEl) nameEl.textContent = currentTrip.title || '--';
    if (destEl) destEl.textContent = currentTrip.destination || '--';
    if (priceEl) priceEl.textContent = `${(Number(currentTrip.price) || 0).toLocaleString()} ج.م`;
    
    let dateStr = currentTrip.date ? formatDate(currentTrip.date) : '--';
    if (currentTrip.endDate && currentTrip.endDate !== currentTrip.date) {
        dateStr += ` إلى ${formatDate(currentTrip.endDate)}`;
    }
    if (dateEl) dateEl.textContent = dateStr;

    if (notesEl) {
        if (currentTrip.notes && currentTrip.notes.trim()) {
            notesEl.textContent = currentTrip.notes.trim();
            notesEl.style.display = 'block';
        } else {
            notesEl.style.display = 'none';
        }
    }

    if (statusBadge) {
        const isCompleted = currentTrip.status === 'completed';
        statusBadge.textContent = isCompleted ? 'منتهية (أرشيف)' : 'جارية (حالية)';
        statusBadge.className = `trip-status-badge ${isCompleted ? 'completed' : ''}`;
    }

    // Financial KPIs (Strictly scoped to currentTrip)
    const bookings = currentTrip.bookings || [];
    const totalExpected = bookings.reduce((sum, b) => sum + (Number(b.price) || 0), 0);
    const totalCollected = bookings.reduce((sum, b) => sum + (Number(b.paid) || 0), 0);
    const totalRemaining = Math.max(0, totalExpected - totalCollected);

    // Update Dossier Banner & Card Titles
    const kpiTripIndependentName = document.getElementById('kpi-trip-independent-name');
    if (kpiTripIndependentName) kpiTripIndependentName.textContent = currentTrip.title || '--';

    document.querySelectorAll('.kpi-trip-scoped-title').forEach(el => {
        el.textContent = currentTrip.title || '--';
    });

    const bookingsTripTitle = document.getElementById('bookings-trip-title');
    if (bookingsTripTitle) bookingsTripTitle.textContent = currentTrip.title || '--';

    const kpiTotalEl = document.getElementById('kpi-total-amount');
    const kpiCollectedEl = document.getElementById('kpi-collected-amount');
    const kpiRemainingEl = document.getElementById('kpi-remaining-amount');
    const kpiTotalSub = document.getElementById('kpi-total-subtext');
    const kpiCollectedSub = document.getElementById('kpi-collected-subtext');
    const kpiRemainingSub = document.getElementById('kpi-remaining-subtext');
    const kpiProgressBar = document.getElementById('kpi-progress-bar');
    const kpiProgressPercent = document.getElementById('kpi-progress-percent');
    const kpiBreakdown = document.getElementById('kpi-participants-breakdown');

    if (kpiTotalEl) kpiTotalEl.textContent = totalExpected.toLocaleString();
    if (kpiCollectedEl) kpiCollectedEl.textContent = totalCollected.toLocaleString();
    if (kpiRemainingEl) kpiRemainingEl.textContent = totalRemaining.toLocaleString();

    const percent = totalExpected > 0 ? Math.round((totalCollected / totalExpected) * 100) : (bookings.length > 0 ? 100 : 0);
    if (kpiTotalSub) kpiTotalSub.textContent = `إجمالي حجوزات رحلة (${currentTrip.title}) فقط`;
    if (kpiCollectedSub) kpiCollectedSub.textContent = `${percent}% من إجمالي المطلوب لرحلة (${currentTrip.title})`;
    if (kpiRemainingSub) kpiRemainingSub.textContent = `باقي للتحصيل من رحلة (${currentTrip.title})`;
    if (kpiProgressPercent) kpiProgressPercent.textContent = `${percent}%`;
    if (kpiProgressBar) kpiProgressBar.style.width = `${Math.min(100, percent)}%`;

    const servantsCount = bookings.filter(b => b.type === 'servant').length;
    const membersCount = bookings.filter(b => b.type === 'member').length;
    const guestsCount = bookings.filter(b => b.type === 'guest').length;
    const fullyPaidCount = bookings.filter(b => (Number(b.remaining) || 0) <= 0).length;
    const remainingCount = bookings.filter(b => (Number(b.remaining) || 0) > 0).length;

    if (kpiBreakdown) {
        kpiBreakdown.textContent = `${bookings.length} مشترك (${servantsCount} خادم • ${membersCount} مخدوم${guestsCount ? ' • ' + guestsCount + ' ضيف' : ''})`;
    }

    // Update filter counts
    const countAll = document.getElementById('count-filter-all');
    const countServants = document.getElementById('count-filter-servants');
    const countMembers = document.getElementById('count-filter-members');
    const countRemaining = document.getElementById('count-filter-remaining');
    const countPaid = document.getElementById('count-filter-paid');

    if (countAll) countAll.textContent = bookings.length;
    if (countServants) countServants.textContent = servantsCount;
    if (countMembers) countMembers.textContent = membersCount;
    if (countRemaining) countRemaining.textContent = remainingCount;
    if (countPaid) countPaid.textContent = fullyPaidCount;

    // Apply view mode display (Single Dossier vs All Trips Comparison)
    updateTripsViewModeDisplay();

    // Render Bookings List
    renderBookingsList();
}

function renderBookingsList() {
    const trips = getTrips();
    const currentTrip = trips.find(t => t.id === selectedTripId);
    if (!currentTrip) return;

    const bookings = currentTrip.bookings || [];
    let filtered = [...bookings];

    // Filter by type or payment status
    if (currentBookingFilter === 'servants') {
        filtered = filtered.filter(b => b.type === 'servant');
    } else if (currentBookingFilter === 'members') {
        filtered = filtered.filter(b => b.type === 'member');
    } else if (currentBookingFilter === 'remaining') {
        filtered = filtered.filter(b => (Number(b.remaining) || 0) > 0);
    } else if (currentBookingFilter === 'paid') {
        filtered = filtered.filter(b => (Number(b.remaining) || 0) <= 0);
    }

    // Search filter
    if (currentBookingSearch) {
        const q = normalizeAr(currentBookingSearch);
        filtered = filtered.filter(b => normalizeAr(b.name).includes(q) || (b.phone && b.phone.includes(q)));
    }

    const tbody = document.getElementById('trip-bookings-tbody');
    const mobileContainer = document.getElementById('trip-bookings-mobile-cards');
    const emptyNotice = document.getElementById('trip-bookings-empty');

    if (filtered.length === 0) {
        if (tbody) tbody.innerHTML = '';
        if (mobileContainer) mobileContainer.innerHTML = '';
        if (emptyNotice) emptyNotice.style.display = 'block';
        return;
    }

    if (emptyNotice) emptyNotice.style.display = 'none';

    // 1. Desktop Table
    if (tbody) {
        tbody.innerHTML = filtered.map((b, idx) => {
            const roleBadge = b.type === 'servant'
                ? '<span class="role-chip servant"><i class="ph ph-star"></i> خادم</span>'
                : b.type === 'member'
                ? '<span class="role-chip member"><i class="ph ph-user"></i> مخدوم</span>'
                : '<span class="role-chip guest"><i class="ph ph-users"></i> ضيف</span>';

            const remainingVal = Number(b.remaining) || 0;
            const paidVal = Number(b.paid) || 0;
            const priceVal = Number(b.price) || 0;

            const paymentBadge = remainingVal <= 0
                ? '<span class="payment-badge paid-full"><i class="ph ph-check-circle"></i> خالص بالكامل</span>'
                : paidVal > 0
                ? `<span class="payment-badge paid-partial"><i class="ph ph-clock"></i> فاضل ${remainingVal.toLocaleString()} ج.م</span>`
                : '<span class="payment-badge paid-zero"><i class="ph ph-warning-circle"></i> لم يدفع</span>';

            const phoneLink = b.phone 
                ? `<a href="tel:${b.phone}" style="color: #94a3b8; text-decoration: none; display: flex; align-items: center; gap: 4px;"><i class="ph ph-phone"></i> ${b.phone}</a>`
                : '<span style="color: var(--text-muted); font-size: 0.78rem;">--</span>';

            return `
                <tr>
                    <td style="color: var(--text-muted); font-size: 0.78rem;">${idx + 1}</td>
                    <td>
                        <div class="person-cell">
                            <span class="person-name">${esc(b.name)}</span>
                            ${roleBadge}
                        </div>
                    </td>
                    <td>${phoneLink}</td>
                    <td style="font-weight: 700; font-family: 'Rubik', sans-serif;">${priceVal.toLocaleString()} ج.م</td>
                    <td style="font-weight: 700; font-family: 'Rubik', sans-serif; color: #34d399;">
                        ${paidVal.toLocaleString()} ج.م
                        ${(b.history && b.history.length > 1) ? `<br><span class="installments-count-badge" title="تم السداد على ${b.history.length} أقساط"><i class="ph ph-stack"></i> ${b.history.length} أقساط</span>` : ''}
                    </td>
                    <td style="font-weight: 700; font-family: 'Rubik', sans-serif; color: ${remainingVal > 0 ? '#fbbf24' : '#34d399'};">
                        ${remainingVal.toLocaleString()} ج.م
                    </td>
                    <td>${paymentBadge}</td>
                    <td style="font-size: 0.78rem; color: #cbd5e1; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        ${b.notes ? esc(b.notes) : '<span style="color: rgba(255,255,255,0.2);">--</span>'}
                    </td>
                    <td class="actions-col">
                        <div style="display: flex; gap: 6px; align-items: center;">
                            ${remainingVal > 0 ? `
                            <button class="btn btn-outline btn-sm text-emerald" data-action="quick-pay" data-booking-id="${b.id}" title="سداد قسط / دفعة جديدة">
                                <i class="ph ph-hand-coins"></i> سداد قسط
                            </button>
                            ` : `
                            <button class="btn btn-outline btn-sm" style="color: #67e8f9; border-color: rgba(103, 232, 249, 0.35);" data-action="quick-pay" data-booking-id="${b.id}" title="عرض سجل الأقساط والدفعات">
                                <i class="ph ph-receipt"></i> الأقساط ${(b.history && b.history.length > 0) ? `(${b.history.length})` : ''}
                            </button>
                            `}
                            <button class="btn btn-outline btn-sm" data-action="edit-booking" data-booking-id="${b.id}" title="تعديل الحجز">
                                <i class="ph ph-pencil"></i>
                            </button>
                            <button class="btn btn-outline btn-sm text-danger" data-action="delete-booking" data-booking-id="${b.id}" title="حذف الحجز">
                                <i class="ph ph-trash"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    // 2. Mobile Cards
    if (mobileContainer) {
        mobileContainer.innerHTML = filtered.map(b => {
            const roleBadge = b.type === 'servant'
                ? '<span class="role-chip servant"><i class="ph ph-star"></i> خادم</span>'
                : b.type === 'member'
                ? '<span class="role-chip member"><i class="ph ph-user"></i> مخدوم</span>'
                : '<span class="role-chip guest"><i class="ph ph-users"></i> ضيف</span>';

            const remainingVal = Number(b.remaining) || 0;
            const paidVal = Number(b.paid) || 0;
            const priceVal = Number(b.price) || 0;

            const paymentBadge = remainingVal <= 0
                ? '<span class="payment-badge paid-full"><i class="ph ph-check-circle"></i> خالص</span>'
                : paidVal > 0
                ? `<span class="payment-badge paid-partial"><i class="ph ph-clock"></i> فاضل ${remainingVal} ج.م</span>`
                : '<span class="payment-badge paid-zero"><i class="ph ph-warning-circle"></i> لم يدفع</span>';

            return `
                <div class="booking-mobile-card">
                    <div class="bmc-top">
                        <div class="bmc-person">
                            <span class="bmc-name">${esc(b.name)}</span>
                            <div style="display: flex; align-items: center; gap: 6px;">
                                ${roleBadge}
                                ${b.phone ? `<a href="tel:${b.phone}" class="bmc-phone"><i class="ph ph-phone"></i> ${b.phone}</a>` : ''}
                            </div>
                        </div>
                        <div>${paymentBadge}</div>
                    </div>

                    <div class="bmc-financials">
                        <div class="bmc-fin-item">
                            <span class="bmc-fin-label">سعر الرحلة</span>
                            <span class="bmc-fin-val" style="color: #fff;">${priceVal.toLocaleString()}</span>
                        </div>
                        <div class="bmc-fin-item">
                            <span class="bmc-fin-label">المدفوع</span>
                            <span class="bmc-fin-val text-emerald">${paidVal.toLocaleString()}</span>
                            ${(b.history && b.history.length > 1) ? `<div class="installments-count-badge" style="margin: 2px auto 0 auto;"><i class="ph ph-stack"></i> ${b.history.length} أقساط</div>` : ''}
                        </div>
                        <div class="bmc-fin-item">
                            <span class="bmc-fin-label">المتبقي</span>
                            <span class="bmc-fin-val ${remainingVal > 0 ? 'text-amber' : 'text-emerald'}">${remainingVal.toLocaleString()}</span>
                        </div>
                    </div>

                    ${b.notes ? `<div class="bmc-notes"><i class="ph ph-note"></i> ${esc(b.notes)}</div>` : ''}

                    <div class="bmc-actions">
                        ${remainingVal > 0 ? `
                        <button class="btn btn-outline btn-sm text-emerald" data-action="quick-pay" data-booking-id="${b.id}">
                            <i class="ph ph-hand-coins"></i> سداد قسط
                        </button>
                        ` : `
                        <button class="btn btn-outline btn-sm" style="color: #67e8f9; border-color: rgba(103, 232, 249, 0.35);" data-action="quick-pay" data-booking-id="${b.id}">
                            <i class="ph ph-receipt"></i> الأقساط ${(b.history && b.history.length > 0) ? `(${b.history.length})` : ''}
                        </button>
                        `}
                        <button class="btn btn-outline btn-sm" data-action="edit-booking" data-booking-id="${b.id}" title="تعديل">
                            <i class="ph ph-pencil"></i> تعديل
                        </button>
                        <button class="btn btn-outline btn-sm text-danger" data-action="delete-booking" data-booking-id="${b.id}" title="حذف">
                            <i class="ph ph-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    if (typeof enforcePermissions === 'function') enforcePermissions();
}

function populateBookingMemberSelect(roleType) {
    const select = document.getElementById('booking-member-select');
    if (!select) return;

    select.innerHTML = '<option value="">-- اختر اسماً مسجلاً لتعبئة البيانات تلقائياً --</option>';
    const allMembers = getMembers();

    let list = [];
    if (roleType === 'servant') {
        list = allMembers.filter(m => m.role === 'servant');
    } else if (roleType === 'member') {
        list = allMembers.filter(m => m.role !== 'servant');
    } else {
        list = allMembers;
    }

    list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));

    list.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.name} ${m.phone ? `(${m.phone})` : ''}`;
        select.appendChild(opt);
    });
}

function openTripModal(tripId) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('trips-edit')) {
        showToast('عفواً، لا تملك صلاحية إضافة أو تعديل الرحلات', 'warning');
        return;
    }

    const editIdInput = document.getElementById('trip-edit-id');
    const titleInput = document.getElementById('trip-input-title');
    const destInput = document.getElementById('trip-input-destination');
    const priceInput = document.getElementById('trip-input-price');
    const dateInput = document.getElementById('trip-input-date');
    const endDateInput = document.getElementById('trip-input-end-date');
    const capacityInput = document.getElementById('trip-input-capacity');
    const statusSelect = document.getElementById('trip-input-status');
    const notesInput = document.getElementById('trip-input-notes');
    const modalTitle = document.getElementById('trip-modal-title');

    if (tripId) {
        const trip = getTrips().find(t => t.id === tripId);
        if (!trip) return;

        if (editIdInput) editIdInput.value = trip.id;
        if (titleInput) titleInput.value = trip.title || '';
        if (destInput) destInput.value = trip.destination || '';
        if (priceInput) priceInput.value = trip.price || 0;
        if (dateInput) dateInput.value = trip.date || todayLocal();
        if (endDateInput) endDateInput.value = trip.endDate || '';
        if (capacityInput) capacityInput.value = trip.capacity || '';
        if (statusSelect) statusSelect.value = trip.status || 'active';
        if (notesInput) notesInput.value = trip.notes || '';
        if (modalTitle) modalTitle.innerHTML = '<i class="ph ph-compass"></i> تعديل بيانات الرحلة';
    } else {
        if (editIdInput) editIdInput.value = '';
        if (titleInput) titleInput.value = '';
        if (destInput) destInput.value = '';
        if (priceInput) priceInput.value = '';
        if (dateInput) dateInput.value = todayLocal();
        if (endDateInput) endDateInput.value = '';
        if (capacityInput) capacityInput.value = '';
        if (statusSelect) statusSelect.value = 'active';
        if (notesInput) notesInput.value = '';
        if (modalTitle) modalTitle.innerHTML = '<i class="ph ph-compass"></i> إضافة رحلة أو مؤتمر جديد';
    }

    const modal = document.getElementById('trip-modal');
    if (modal) modal.classList.add('active');
}

function saveTripData() {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('trips-edit')) {
        showToast('عفواً، لا تملك صلاحية حفظ أو تعديل الرحلات', 'warning');
        return;
    }

    const editId = document.getElementById('trip-edit-id')?.value;
    const title = document.getElementById('trip-input-title')?.value.trim();
    const destination = document.getElementById('trip-input-destination')?.value.trim();
    const price = parseFloat(document.getElementById('trip-input-price')?.value) || 0;
    const date = document.getElementById('trip-input-date')?.value || todayLocal();
    const endDate = document.getElementById('trip-input-end-date')?.value || '';
    const capacity = parseInt(document.getElementById('trip-input-capacity')?.value) || null;
    const status = document.getElementById('trip-input-status')?.value || 'active';
    const notes = document.getElementById('trip-input-notes')?.value.trim();

    if (!title) return alert('يرجى كتابة اسم الرحلة أو المؤتمر');
    if (!destination) return alert('يرجى تحديد مكان ووجهة الرحلة');
    if (price <= 0) return alert('يرجى إدخال سعر الفرد بشكل صحيح (أكبر من صفر)');

    const trips = getTrips();

    if (editId) {
        const trip = trips.find(t => t.id === editId);
        if (trip) {
            trip.title = title;
            trip.destination = destination;
            trip.price = price;
            trip.date = date;
            trip.endDate = endDate;
            trip.capacity = capacity;
            trip.status = status;
            trip.notes = notes;
            trip.updatedAt = new Date().toISOString();
        }
    } else {
        const newTrip = {
            id: 'trip_' + Date.now(),
            title,
            destination,
            price,
            date,
            endDate,
            capacity,
            status,
            notes,
            bookings: [],
            createdAt: todayLocal(),
            updatedAt: new Date().toISOString()
        };
        trips.unshift(newTrip);
        selectedTripId = newTrip.id;
    }

    saveTrips(trips);
    document.getElementById('trip-modal')?.classList.remove('active');
    showToast('تم حفظ بيانات الرحلة بنجاح!', 'success');
    refreshTripsView();
}

function deleteTrip(tripId) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('trips-edit')) {
        showToast('عفواً، لا تملك صلاحية حذف الرحلات', 'warning');
        return;
    }

    if (!confirm('هل أنت متأكد من حذف هذه الرحلة بجميع حجوزاتها وسجلاتها المالية؟ لا يمكن التراجع عن هذا الإجراء!')) {
        return;
    }

    if (typeof recordDeletedTripId === 'function') {
        recordDeletedTripId(tripId);
    }

    let trips = getTrips().filter(t => t.id !== tripId);
    saveTrips(trips);
    selectedTripId = trips.length > 0 ? trips[0].id : null;
    showToast('تم حذف الرحلة بنجاح', 'info');
    refreshTripsView();
}

function openBookingModal(bookingId) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('trips-edit')) {
        showToast('عفواً، لا تملك صلاحية إضافة أو تعديل الحجوزات', 'warning');
        return;
    }

    const allTrips = getTrips();
    let trip = allTrips.find(t => t.id === selectedTripId);
    if (!trip && allTrips.length > 0) {
        selectedTripId = allTrips[0].id;
        trip = allTrips[0];
    }
    if (!trip) {
        showToast('برجاء إضافة رحلة أولاً لإضافة الحجز إليها', 'warning');
        return;
    }

    const editIdInput = document.getElementById('booking-edit-id');
    const nameInput = document.getElementById('booking-input-name');
    const phoneInput = document.getElementById('booking-input-phone');
    const priceInput = document.getElementById('booking-input-price');
    const paidInput = document.getElementById('booking-input-paid');
    const notesInput = document.getElementById('booking-input-notes');
    const modalTitle = document.getElementById('booking-modal-title');

    if (bookingId) {
        const booking = trip.bookings?.find(b => b.id === bookingId);
        if (!booking) return;

        if (editIdInput) editIdInput.value = booking.id;
        if (nameInput) nameInput.value = booking.name || '';
        if (phoneInput) phoneInput.value = booking.phone || '';
        if (priceInput) priceInput.value = booking.price ?? trip.price;
        if (paidInput) paidInput.value = booking.paid ?? 0;
        if (notesInput) notesInput.value = booking.notes || '';

        // Select type pill
        const type = booking.type || 'member';
        const radio = document.querySelector(`input[name="booking-person-type"][value="${type}"]`);
        if (radio) {
            radio.checked = true;
            document.querySelectorAll('.booking-type-pill').forEach(p => p.classList.remove('active'));
            radio.closest('.booking-type-pill')?.classList.add('active');
        }
        populateBookingMemberSelect(type);

        if (modalTitle) modalTitle.innerHTML = '<i class="ph ph-pencil-simple"></i> تعديل بيانات الحجز';
    } else {
        if (editIdInput) editIdInput.value = '';
        if (nameInput) nameInput.value = '';
        if (phoneInput) phoneInput.value = '';
        if (priceInput) priceInput.value = trip.price || 0;
        if (paidInput) paidInput.value = 0;
        if (notesInput) notesInput.value = '';

        // Default to member
        const defaultRadio = document.querySelector('input[name="booking-person-type"][value="member"]');
        if (defaultRadio) {
            defaultRadio.checked = true;
            document.querySelectorAll('.booking-type-pill').forEach(p => p.classList.remove('active'));
            defaultRadio.closest('.booking-type-pill')?.classList.add('active');
        }
        populateBookingMemberSelect('member');

        if (modalTitle) modalTitle.innerHTML = '<i class="ph ph-user-plus"></i> إضافة حجز جديد';
    }

    // Trigger remaining calculation
    if (priceInput) priceInput.dispatchEvent(new Event('input'));

    const modal = document.getElementById('booking-modal');
    if (modal) modal.classList.add('active');
}

function saveBookingData() {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('trips-edit')) {
        showToast('عفواً، لا تملك صلاحية حفظ الحجوزات', 'warning');
        return;
    }

    const trips = getTrips();
    let trip = trips.find(t => t.id === selectedTripId);
    if (!trip && trips.length > 0) {
        selectedTripId = trips[0].id;
        trip = trips[0];
    }
    if (!trip) {
        showToast('برجاء إضافة رحلة أولاً لتسجيل الحجز بها', 'warning');
        return;
    }

    const editId = document.getElementById('booking-edit-id')?.value;
    const name = document.getElementById('booking-input-name')?.value.trim();
    const phone = document.getElementById('booking-input-phone')?.value.trim();
    const price = Math.max(0, parseFloat(document.getElementById('booking-input-price')?.value) || 0);
    const paid = Math.max(0, parseFloat(document.getElementById('booking-input-paid')?.value) || 0);
    const notes = document.getElementById('booking-input-notes')?.value.trim();
    const typeRadio = document.querySelector('input[name="booking-person-type"]:checked');
    const type = typeRadio ? typeRadio.value : 'member';
    const memberId = document.getElementById('booking-member-select')?.value || null;

    if (!name) return alert('يرجى كتابة اسم المشترك بالكامل');
    if (price <= 0) return alert('يرجى إدخال سعر الحجز بشكل صحيح');

    const remaining = Math.max(0, price - paid);
    const nowIso = new Date().toISOString();

    trip.bookings = trip.bookings || [];

    if (editId) {
        const booking = trip.bookings.find(b => b.id === editId);
        if (booking) {
            booking.name = name;
            booking.phone = phone;
            booking.price = price;
            booking.paid = paid;
            booking.remaining = remaining;
            booking.type = type;
            booking.notes = notes;
            if (memberId) booking.memberId = memberId;
            booking.updatedAt = nowIso;
        }
    } else {
        const newBooking = {
            id: 'b_' + Date.now() + Math.random().toString(36).substr(2, 4),
            name,
            phone,
            type,
            price,
            paid,
            remaining,
            notes,
            memberId,
            createdAt: todayLocal(),
            updatedAt: nowIso,
            history: paid > 0 ? [{ id: 'pay_' + Date.now(), amount: paid, date: todayLocal(), note: 'دفعة أولى (مقدم حجز)' }] : []
        };
        trip.bookings.unshift(newBooking);
    }

    saveTrips(trips);
    document.getElementById('booking-modal')?.classList.remove('active');
    showToast('تم حفظ الحجز بنجاح!', 'success');
    refreshTripsView();
}

function openQuickPayModal(bookingId) {
    const allTrips = getTrips();
    let trip = allTrips.find(t => t.id === selectedTripId);
    if (!trip && allTrips.length > 0) {
        selectedTripId = allTrips[0].id;
        trip = allTrips[0];
    }
    const booking = trip?.bookings?.find(b => b.id === bookingId);
    if (!booking) return;

    const idInput = document.getElementById('quick-pay-booking-id');
    const nameEl = document.getElementById('quick-pay-name');
    const roleBadgeEl = document.getElementById('quick-pay-role-badge');
    const totalEl = document.getElementById('quick-pay-total-price');
    const alreadyEl = document.getElementById('quick-pay-already-paid');
    const currentRemEl = document.getElementById('quick-pay-current-remaining');
    const amountInput = document.getElementById('quick-pay-input-amount');
    const noteInput = document.getElementById('quick-pay-input-note');
    const newRemEl = document.getElementById('quick-pay-new-remaining');
    const chipsContainer = document.getElementById('quick-pay-chips-container');
    const formSection = document.getElementById('quick-pay-form-section');
    const fullyPaidBanner = document.getElementById('quick-pay-fully-paid-banner');
    const saveBtn = document.getElementById('btn-save-quick-pay');
    const historyListEl = document.getElementById('quick-pay-history-list');
    const historyCountEl = document.getElementById('quick-pay-history-count');

    // Normalize history array
    booking.history = Array.isArray(booking.history) ? booking.history : [];
    if (booking.history.length === 0 && Number(booking.paid) > 0) {
        booking.history.push({
            id: 'pay_init_' + (booking.id || Date.now()),
            amount: Number(booking.paid),
            date: booking.createdAt || todayLocal(),
            note: 'دفعة أولى (مقدم حجز)'
        });
    }
    booking.history.forEach((h, idx) => {
        if (!h.id) h.id = 'pay_' + idx + '_' + Math.random().toString(36).substr(2, 4);
    });

    const price = Number(booking.price) || 0;
    const paid = booking.history.reduce((sum, h) => sum + (Number(h.amount) || 0), 0);
    booking.paid = paid;
    const remaining = Math.max(0, price - paid);
    booking.remaining = remaining;

    if (idInput) idInput.value = booking.id;
    if (nameEl) nameEl.textContent = booking.name;
    if (roleBadgeEl) {
        roleBadgeEl.innerHTML = booking.type === 'servant'
            ? '<span class="role-chip servant"><i class="ph ph-star"></i> خادم</span>'
            : booking.type === 'member'
            ? '<span class="role-chip member"><i class="ph ph-user"></i> مخدوم</span>'
            : '<span class="role-chip guest"><i class="ph ph-users"></i> ضيف</span>';
    }
    if (totalEl) totalEl.textContent = price.toLocaleString();
    if (alreadyEl) alreadyEl.textContent = paid.toLocaleString();
    if (currentRemEl) currentRemEl.textContent = remaining.toLocaleString();

    // Populate Previous Installments History
    if (historyCountEl) historyCountEl.textContent = booking.history.length;
    if (historyListEl) {
        if (booking.history.length === 0) {
            historyListEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 12px 0;">لا توجد دفعات أو أقساط مسجلة حتى الآن.</div>';
        } else {
            historyListEl.innerHTML = booking.history.map((h, idx) => {
                const hAmount = Number(h.amount) || 0;
                const hDate = h.date || '--';
                const hNote = h.note || `قسط ${idx + 1}`;
                return `
                    <div class="payment-history-item">
                        <div class="phi-left">
                            <span class="phi-num">قسط ${idx + 1}</span>
                            <div>
                                <span class="phi-amount">${hAmount.toLocaleString()} ج.م</span>
                                <span class="phi-meta" style="margin-right: 6px;">(${esc(hNote)})</span>
                            </div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span class="phi-meta">${esc(hDate)}</span>
                            <button class="phi-delete-btn" onclick="deletePaymentInstallment('${booking.id}', '${h.id}')" title="حذف هذا القسط">
                                <i class="ph ph-trash"></i>
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    // Build Quick Installment Chips
    if (chipsContainer) {
        chipsContainer.innerHTML = '';
        if (remaining > 0) {
            const presetAmounts = [50, 100, 200, 500].filter(amt => amt < remaining);
            presetAmounts.forEach(amt => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'installment-chip';
                btn.innerHTML = `<i class="ph ph-plus"></i> ${amt.toLocaleString()} ج.م`;
                btn.onclick = () => {
                    if (amountInput) {
                        amountInput.value = amt;
                        amountInput.dispatchEvent(new Event('input'));
                        amountInput.focus();
                    }
                };
                chipsContainer.appendChild(btn);
            });

            if (remaining > 100 && !presetAmounts.includes(Math.round(remaining / 2))) {
                const halfAmt = Math.round(remaining / 2);
                const halfBtn = document.createElement('button');
                halfBtn.type = 'button';
                halfBtn.className = 'installment-chip';
                halfBtn.innerHTML = `<i class="ph ph-divide"></i> نصف المتبقي (${halfAmt.toLocaleString()} ج.م)`;
                halfBtn.onclick = () => {
                    if (amountInput) {
                        amountInput.value = halfAmt;
                        amountInput.dispatchEvent(new Event('input'));
                        amountInput.focus();
                    }
                };
                chipsContainer.appendChild(halfBtn);
            }

            const fullBtn = document.createElement('button');
            fullBtn.type = 'button';
            fullBtn.className = 'installment-chip chip-full';
            fullBtn.innerHTML = `<i class="ph ph-check"></i> كامل المتبقي (${remaining.toLocaleString()} ج.م)`;
            fullBtn.onclick = () => {
                if (amountInput) {
                    amountInput.value = remaining;
                    amountInput.dispatchEvent(new Event('input'));
                    amountInput.focus();
                }
            };
            chipsContainer.appendChild(fullBtn);
        }
    }

    if (remaining <= 0) {
        if (formSection) formSection.style.display = 'none';
        if (fullyPaidBanner) fullyPaidBanner.style.display = 'block';
        if (saveBtn) saveBtn.style.display = 'none';
    } else {
        if (formSection) formSection.style.display = 'block';
        if (fullyPaidBanner) fullyPaidBanner.style.display = 'none';
        if (saveBtn) saveBtn.style.display = 'inline-flex';

        if (amountInput) amountInput.value = '';
        if (noteInput) noteInput.value = `قسط رقم ${booking.history.length + 1}`;
        if (newRemEl) {
            newRemEl.className = 'text-emerald';
            newRemEl.textContent = `${remaining.toLocaleString()} ج.م`;
        }
    }

    const modal = document.getElementById('quick-pay-modal');
    if (modal) modal.classList.add('active');
}

function saveQuickPayment() {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('trips-edit')) {
        showToast('عفواً، لا تملك صلاحية تسجيل دفعات السداد', 'warning');
        return;
    }

    const bookingId = document.getElementById('quick-pay-booking-id')?.value;
    const amount = parseFloat(document.getElementById('quick-pay-input-amount')?.value) || 0;
    const note = document.getElementById('quick-pay-input-note')?.value.trim();

    if (amount <= 0) return alert('يرجى إدخال مبلغ قسط صالح أكبر من صفر');

    const trips = getTrips();
    let trip = trips.find(t => t.id === selectedTripId);
    if (!trip && trips.length > 0) {
        selectedTripId = trips[0].id;
        trip = trips[0];
    }
    const booking = trip?.bookings?.find(b => b.id === bookingId);
    if (!booking) return;

    booking.history = Array.isArray(booking.history) ? booking.history : [];
    if (booking.history.length === 0 && Number(booking.paid) > 0) {
        booking.history.push({
            id: 'pay_init_' + (booking.id || Date.now()),
            amount: Number(booking.paid),
            date: booking.createdAt || todayLocal(),
            note: 'دفعة أولى (مقدم حجز)'
        });
    }

    const installmentId = 'pay_' + Date.now() + Math.random().toString(36).substr(2, 4);
    booking.history.push({
        id: installmentId,
        amount: amount,
        date: todayLocal(),
        note: note || `قسط رقم ${booking.history.length + 1}`
    });

    booking.paid = booking.history.reduce((sum, h) => sum + (Number(h.amount) || 0), 0);
    booking.remaining = Math.max(0, (Number(booking.price) || 0) - booking.paid);
    booking.updatedAt = new Date().toISOString();

    saveTrips(trips);
    document.getElementById('quick-pay-modal')?.classList.remove('active');
    
    if (booking.remaining <= 0) {
        showToast(`تم سداد ${amount.toLocaleString()} ج.م، واكتمل سداد كامل المبلغ بنجاح! 🎉`, 'success');
    } else {
        showToast(`تم تسجيل قسط ${amount.toLocaleString()} ج.م بنجاح! متبقي: ${booking.remaining.toLocaleString()} ج.م`, 'success');
    }
    refreshTripsView();
}

function deletePaymentInstallment(bookingId, paymentId) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('trips-edit')) {
        showToast('عفواً، لا تملك صلاحية تعديل أو حذف الدفعات', 'warning');
        return;
    }
    if (!confirm('هل أنت متأكد من حذف هذا القسط / الدفعة؟ سيتم إعادة خصمها من الإجمالي وحساب المتبقي تلقائياً.')) return;

    const trips = getTrips();
    let trip = trips.find(t => t.id === selectedTripId);
    if (!trip && trips.length > 0) {
        selectedTripId = trips[0].id;
        trip = trips[0];
    }
    const booking = trip?.bookings?.find(b => b.id === bookingId);
    if (!booking) return;

    booking.history = (booking.history || []).filter(h => h.id !== paymentId);
    booking.paid = booking.history.reduce((sum, h) => sum + (Number(h.amount) || 0), 0);
    booking.remaining = Math.max(0, (Number(booking.price) || 0) - booking.paid);
    booking.updatedAt = new Date().toISOString();

    saveTrips(trips);
    showToast('تم حذف القسط وإعادة ضبط المتبقي بنجاح', 'info');
    openQuickPayModal(bookingId);
    refreshTripsView();
}
window.deletePaymentInstallment = deletePaymentInstallment;

function deleteBooking(bookingId) {
    if (currentUserRole !== 'admin' && !currentPermissions.includes('trips-edit')) {
        showToast('عفواً، لا تملك صلاحية حذف الحجوزات', 'warning');
        return;
    }

    if (!confirm('هل أنت متأكد من حذف هذا الحجز نهائياً؟')) return;

    const trips = getTrips();
    let trip = trips.find(t => t.id === selectedTripId);
    if (!trip && trips.length > 0) {
        selectedTripId = trips[0].id;
        trip = trips[0];
    }
    if (!trip) return;

    if (typeof recordDeletedBookingId === 'function') {
        recordDeletedBookingId(bookingId);
    }

    trip.bookings = (trip.bookings || []).filter(b => b.id !== bookingId);
    saveTrips(trips);
    showToast('تم حذف الحجز بنجاح', 'info');
    refreshTripsView();
}

function exportTripToExcel() {
    const trip = getTrips().find(t => t.id === selectedTripId);
    if (!trip || !(trip.bookings || []).length) {
        showToast('لا توجد حجوزات لتصديرها في هذه الرحلة', 'warning');
        return;
    }

    if (typeof XLSX === 'undefined') {
        alert('مكتبة الإكسيل غير محملة، يرجى التحقق من الاتصال بالإنترنت.');
        return;
    }

    const rows = trip.bookings.map((b, idx) => {
        const rem = Number(b.remaining) || 0;
        const paid = Number(b.paid) || 0;
        const price = Number(b.price) || 0;
        const statusText = rem <= 0 ? 'خالص بالكامل' : paid > 0 ? `متبقي ${rem} ج.م` : 'لم يسدد';

        return {
            'م': idx + 1,
            'الاسم': b.name,
            'الصفة': b.type === 'servant' ? 'خادم' : b.type === 'member' ? 'مخدوم' : 'ضيف',
            'رقم التليفون': b.phone || '',
            'سعر الحجز (ج.م)': price,
            'المدفوع (ج.م)': paid,
            'المتبقي (ج.م)': rem,
            'حالة السداد': statusText,
            'ملاحظات': b.notes || ''
        };
    });

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'كشف الحجوزات');

    const cleanTitle = (trip.title || 'رحلة').replace(/[\/\\?%*:|"<>]/g, '_');
    XLSX.writeFile(workbook, `كشف_حجوزات_${cleanTitle}_${todayLocal()}.xlsx`);
    showToast('تم تصدير ملف الإكسيل بنجاح!', 'success');
}

function printTripReport() {
    const trip = getTrips().find(t => t.id === selectedTripId);
    if (!trip || !(trip.bookings || []).length) {
        showToast('لا توجد حجوزات للطباعة في هذه الرحلة', 'warning');
        return;
    }

    const bookings = trip.bookings || [];
    const totalExpected = bookings.reduce((sum, b) => sum + (Number(b.price) || 0), 0);
    const totalCollected = bookings.reduce((sum, b) => sum + (Number(b.paid) || 0), 0);
    const totalRemaining = Math.max(0, totalExpected - totalCollected);

    const printWin = window.open('', '_blank');
    if (!printWin) {
        alert('يرجى السماح بالنوافذ المنبثقة لطباعة الكشف');
        return;
    }

    const tableRows = bookings.map((b, idx) => {
        const rem = Number(b.remaining) || 0;
        const paid = Number(b.paid) || 0;
        const price = Number(b.price) || 0;
        const roleLabel = b.type === 'servant' ? 'خادم' : b.type === 'member' ? 'مخدوم' : 'ضيف';
        const statusLabel = rem <= 0 ? 'خالص' : `باقي ${rem}`;

        return `
            <tr>
                <td style="text-align: center;">${idx + 1}</td>
                <td><strong>${esc(b.name)}</strong></td>
                <td style="text-align: center;">${roleLabel}</td>
                <td style="direction: ltr; text-align: center;">${esc(b.phone || '')}</td>
                <td style="text-align: center;">${price}</td>
                <td style="text-align: center; color: #047857;">${paid}</td>
                <td style="text-align: center; color: ${rem > 0 ? '#b45309' : '#047857'}; font-weight: bold;">${statusLabel}</td>
                <td>${esc(b.notes || '')}</td>
                <td style="width: 70px; border-bottom: 1px dotted #ccc;"></td>
            </tr>
        `;
    }).join('');

    printWin.document.write(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <title>كشف ${esc(trip.title)}</title>
            <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
            <style>
                body { font-family: 'Cairo', sans-serif; padding: 20px; color: #111; direction: rtl; }
                .header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 12px; margin-bottom: 15px; }
                .header h1 { margin: 0 0 6px; font-size: 1.5rem; }
                .header h2 { margin: 0 0 8px; font-size: 1.2rem; color: #444; }
                .meta-strip { display: flex; justify-content: space-around; background: #f1f5f9; padding: 8px; border-radius: 6px; font-size: 0.9rem; margin-bottom: 15px; }
                .stats-strip { display: flex; justify-content: space-around; border: 1px solid #cbd5e1; padding: 8px; border-radius: 6px; font-size: 0.95rem; margin-bottom: 15px; background: #fafafa; font-weight: bold; }
                table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
                th, td { border: 1px solid #94a3b8; padding: 6px 8px; }
                th { background: #e2e8f0; font-weight: bold; }
                @media print {
                    button { display: none; }
                    body { padding: 0; }
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>اجتماع القديس يوحنا الحبيب</h1>
                <h2>كشف حجز: ${esc(trip.title)}</h2>
            </div>
            <div class="meta-strip">
                <span>المكان: <strong>${esc(trip.destination || '--')}</strong></span>
                <span>سعر الفرد: <strong>${(Number(trip.price) || 0)} ج.م</strong></span>
                <span>التاريخ: <strong>${trip.date ? formatDate(trip.date) : '--'}</strong></span>
                <span>إجمالي المشتركين: <strong>${bookings.length}</strong></span>
            </div>
            <div class="stats-strip">
                <span>المبلغ الإجمالي: ${(totalExpected).toLocaleString()} ج.م</span>
                <span style="color: #047857;">المحصل (الي اتلم): ${(totalCollected).toLocaleString()} ج.م</span>
                <span style="color: #b45309;">المطلوب (الي فاضل): ${(totalRemaining).toLocaleString()} ج.م</span>
            </div>
            <table>
                <thead>
                    <tr>
                        <th style="width: 35px;">#</th>
                        <th>الاسم</th>
                        <th style="width: 70px;">الصفة</th>
                        <th style="width: 100px;">التليفون</th>
                        <th style="width: 60px;">السعر</th>
                        <th style="width: 60px;">المدفوع</th>
                        <th style="width: 80px;">المتبقي</th>
                        <th>ملاحظات</th>
                        <th style="width: 70px;">حضور الباص</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>
            <div style="margin-top: 25px; display: flex; justify-content: space-between; font-size: 0.9rem;">
                <div>تاريخ الطباعة: ${todayLocal()}</div>
                <div>توقيع أمين الرحلة: ..........................</div>
            </div>
            <script>
                window.onload = function() { window.print(); }
            <\/script>
        </body>
        </html>
    `);
    printWin.document.close();
}

