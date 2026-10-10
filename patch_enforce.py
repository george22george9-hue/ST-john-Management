import io
import re

filepath = r'c:\الكنيسة\خطة الأجتماع\برنامج الحضور\app.js'
with io.open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add enforcePermissions to applyPermissions
target_block = '''    if (activeBtn && activeBtn.style.display === 'none') {
        const firstVisible = document.querySelector('.nav-btn[style="display: flex;"]');
        if (firstVisible) firstVisible.click();
    }
}'''

replacement_block = '''    if (activeBtn && activeBtn.style.display === 'none') {
        const firstVisible = document.querySelector('.nav-btn[style="display: flex;"]');
        if (firstVisible) firstVisible.click();
    }
    
    // Make sure we enforce permissions immediately on load
    if (typeof enforcePermissions === 'function') {
        enforcePermissions();
    }
}'''

content = content.replace(target_block, replacement_block)

# 2. Add enforcePermissions to the switchPage logic (click listeners)
# We find:
#         views.forEach(v => v.classList.remove('active'));
#         document.getElementById(targetId).classList.add('active');
#     });
# });
target_click = '''        document.getElementById(targetId).classList.add('active');
    });
});'''

replacement_click = '''        document.getElementById(targetId).classList.add('active');
        if (typeof enforcePermissions === 'function') enforcePermissions();
    });
});'''
content = content.replace(target_click, replacement_click)


# Better approach: monkey patch them at the end of the file!
monkey_patch = '''
// --- Permissions Enforcement Patch ---
(function() {
    if (typeof enforcePermissions !== 'function') return;
    
    const originalRenderDashboard = window.renderDashboard;
    if (originalRenderDashboard) {
        window.renderDashboard = function(...args) { originalRenderDashboard.apply(this, args); enforcePermissions(); };
    }
    
    const originalRenderAttendance = window.renderAttendance;
    if (originalRenderAttendance) {
        window.renderAttendance = function(...args) { originalRenderAttendance.apply(this, args); enforcePermissions(); };
    }
    
    const originalRenderFollowup = window.renderFollowup;
    if (originalRenderFollowup) {
        window.renderFollowup = function(...args) { originalRenderFollowup.apply(this, args); enforcePermissions(); };
    }
    
    const originalRenderServantsDashboard = window.renderServantsDashboard;
    if (originalRenderServantsDashboard) {
        window.renderServantsDashboard = function(...args) { originalRenderServantsDashboard.apply(this, args); enforcePermissions(); };
    }
    
    const originalRenderCompetitions = window.renderCompetitions;
    if (originalRenderCompetitions) {
        window.renderCompetitions = function(...args) { originalRenderCompetitions.apply(this, args); enforcePermissions(); };
    }
    
    const originalRenderSummary = window.renderSummary;
    if (originalRenderSummary) {
        window.renderSummary = function(...args) { originalRenderSummary.apply(this, args); enforcePermissions(); };
    }
})();
'''

if 'Permissions Enforcement Patch' not in content:
    content += monkey_patch

with io.open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
