import io
import re

filepath = r'c:\الكنيسة\خطة الأجتماع\برنامج الحضور\app.js'
with io.open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Update load logic in renderPermissionsList()
load_old = r"Array\.from\(document\.querySelectorAll\('\.perm-chk'\)\)\.forEach\(chk => \{\s*chk\.checked = perms\.includes\(chk\.value\);\s*\}\);"
load_new = """Array.from(document.querySelectorAll('.perm-select')).forEach(sel => {
                const section = sel.getAttribute('data-section');
                if (perms.includes(section + '-edit')) {
                    sel.value = 'edit';
                } else if (perms.includes(section + '-view')) {
                    sel.value = 'view';
                } else {
                    sel.value = 'none';
                }
            });"""
content = re.sub(load_old, load_new, content)

# Update save logic in document.getElementById('btn-save-permissions').addEventListener
save_old = r"const selectedPerms = Array\.from\(document\.querySelectorAll\('\.perm-chk:checked'\)\)\.map\(chk => chk\.value\);"
save_new = """const selectedPerms = [];
            Array.from(document.querySelectorAll('.perm-select')).forEach(sel => {
                const val = sel.value;
                const sec = sel.getAttribute('data-section');
                if (val === 'view') {
                    selectedPerms.push(sec + '-view');
                } else if (val === 'edit') {
                    selectedPerms.push(sec + '-view');
                    selectedPerms.push(sec + '-edit');
                }
            });"""
content = re.sub(save_old, save_new, content)

# Now, implement the generic enforcePermissions() function
enforce_func = """
function enforcePermissions() {
    if (currentUserRole === 'admin') return; // Admin sees everything
    
    // Hide or show elements based on permissions
    document.querySelectorAll('[data-perm]').forEach(el => {
        const requiredPerm = el.getAttribute('data-perm');
        if (!currentPermissions.includes(requiredPerm)) {
            el.style.display = 'none';
        } else {
            el.style.display = '';
        }
    });
}
"""
content = content.replace('// --- Authentication & Permissions ---', '// --- Authentication & Permissions ---' + enforce_func)

# And add enforcePermissions() at the end of switchPage()
content = content.replace("page.classList.add('active');\n    });", "page.classList.add('active');\n    });\n    enforcePermissions();")
content = content.replace("page.classList.add('active');\n        });", "page.classList.add('active');\n        });\n        enforcePermissions();")


with io.open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
