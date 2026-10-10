import io
import re

filepath = r'c:\الكنيسة\خطة الأجتماع\برنامج الحضور\app.js'
with io.open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update the default password
content = content.replace("admin: { password: 'admin',", "admin: { password: 'George-STjohn',")

# 2. Add a one-time migration hook to update existing local storage
migration_code = '''
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
'''

content = content.replace('// --- Authentication & Permissions ---', migration_code)

with io.open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
