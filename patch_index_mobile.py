import io

filepath = r'c:\الكنيسة\خطة الأجتماع\برنامج الحضور\index.html'
with io.open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

mobile_header = '''    <!-- Mobile Sidebar Overlay -->
    <div class="sidebar-overlay" id="mobile-sidebar-overlay" onclick="toggleMobileMenu()"></div>

    <!-- Main Content -->
    <div class="main-content">
        <!-- Mobile Header -->
        <div class="mobile-header">
            <h2><i class="ph ph-church"></i> اجتماع القديس يوحنا</h2>
            <button class="hamburger-btn" onclick="toggleMobileMenu()"><i class="ph ph-list"></i></button>
        </div>'''

content = content.replace('    <!-- Main Content -->\n    <div class="main-content">', mobile_header)
content = content.replace('<ul class="sidebar-menu">', '<ul class="sidebar-menu" onclick="if(window.innerWidth <= 900) toggleMobileMenu()">')

with io.open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
