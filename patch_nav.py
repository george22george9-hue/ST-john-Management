import io

filepath = r'c:\الكنيسة\خطة الأجتماع\برنامج الحضور\index.html'
with io.open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace('class="nav-btn"', 'class="nav-btn" onclick="if(window.innerWidth <= 900) toggleMobileMenu()"')

with io.open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
