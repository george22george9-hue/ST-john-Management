import io

filepath = r'c:\الكنيسة\خطة الأجتماع\برنامج الحضور\app.js'
with io.open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Add data-perm="admin-edit" to edit/delete buttons in admin table
content = content.replace("class='btn-action edit'", "class='btn-action edit' data-perm='admin-edit'")
content = content.replace("class='btn-action delete'", "class='btn-action delete' data-perm='admin-edit'")

# Add data-perm="competitions-edit" to competition delete buttons
content = content.replace("class='btn-action delete' onclick='deleteCompetition", "class='btn-action delete' data-perm='competitions-edit' onclick='deleteCompetition")

# Add enforcePermissions() at the end of these render functions:
def append_enforce(func_name, content):
    return content.replace(f"function {func_name}(", f"function {func_name}(")

content = content.replace("function setupAdminTable() {", "function setupAdminTable() {") # wait, better to inject at the end.
# It's easier to just call enforcePermissions() in all render functions via regex.

# We will run enforcePermissions every time the modal opens or table renders.
# Actually, the simplest way is to just call it every second, or hook into the render functions.
# Let's add it to the render functions:
functions = ['setupAdminTable', 'renderCompetitions', 'openCompetitionDetails', 'renderAttendanceList', 'renderServantAttendance', 'renderServantWaTasks']
for f_name in functions:
    content = content.replace(f"function {f_name}(", f"function {f_name}_original(")
    wrapper = f"""function {f_name}(...args) {{
    const res = {f_name}_original(...args);
    setTimeout(enforcePermissions, 50);
    return res;
}}
function {f_name}_original("""
    content = content.replace(f"function {f_name}_original(", wrapper)


with io.open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
