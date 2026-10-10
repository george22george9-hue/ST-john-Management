import io

filepath = r'c:\الكنيسة\خطة الأجتماع\برنامج الحضور\index.html'
with io.open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Attendance edit buttons
content = content.replace('id="btn-take-attendance"', 'id="btn-take-attendance" data-perm="attendance-edit"')
content = content.replace('id="btn-add-guest"', 'id="btn-add-guest" data-perm="attendance-edit"')

# Followup edit buttons
content = content.replace('id="btn-save-followup"', 'id="btn-save-followup" data-perm="followup-edit"')

# Servants edit buttons
content = content.replace('id="btn-take-servant-attendance"', 'id="btn-take-servant-attendance" data-perm="servants-dashboard-edit"')
content = content.replace('id="btn-add-wa-task"', 'id="btn-add-wa-task" data-perm="servants-dashboard-edit"')

# Competitions edit buttons
content = content.replace('id="btn-add-competition"', 'id="btn-add-competition" data-perm="competitions-edit"')
content = content.replace('onclick="openAddRoundModal()"', 'onclick="openAddRoundModal()" data-perm="competitions-edit"')

# Admin edit buttons
content = content.replace('id="btn-add-person"', 'id="btn-add-person" data-perm="admin-edit"')
content = content.replace('id="btn-bulk-add"', 'id="btn-bulk-add" data-perm="admin-edit"')
content = content.replace('id="btn-bulk-delete"', 'id="btn-bulk-delete" data-perm="admin-edit"')
content = content.replace('id="btn-mass-delete-all"', 'id="btn-mass-delete-all" data-perm="admin-edit"')

with io.open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
