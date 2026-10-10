import io
import re

filepath = r'c:\الكنيسة\خطة الأجتماع\برنامج الحضور\app.js'
with io.open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

target = '''    const applyFilters = () => {
        const activeFilter = document.querySelector(`${viewId} .filter-btn.active`);
        const filterValue = activeFilter ? activeFilter.getAttribute('data-filter') : 'all';
        const query = searchInput ? searchInput.value.toLowerCase() : '';

        document.querySelectorAll(`${gridSelector} .member-card`).forEach(card => {
            const name = card.querySelector('h3').textContent.toLowerCase();
            const matchesSearch = name.includes(query);
            const cardFilters = card.getAttribute('data-filters').split(' ');
            const matchesFilter = filterValue === 'all' || cardFilters.includes(filterValue);

            card.style.display = matchesSearch && matchesFilter ? 'block' : 'none';
        });
    };'''

replacement = '''    const applyFilters = () => {
        const activeFilter = document.querySelector(`${viewId} .filter-btn.active`);
        const filterValue = activeFilter ? activeFilter.getAttribute('data-filter') : 'all';
        const query = searchInput ? searchInput.value.toLowerCase() : '';
        const regionSelect = document.getElementById('filter-region-followup');
        const regionQuery = (viewId === '#followup-view' && regionSelect) ? regionSelect.value.toLowerCase() : '';

        document.querySelectorAll(`${gridSelector} .member-card`).forEach(card => {
            const name = card.querySelector('h3').textContent.toLowerCase();
            const matchesSearch = name.includes(query);
            const cardFilters = card.getAttribute('data-filters').split(' ');
            const matchesFilter = filterValue === 'all' || cardFilters.includes(filterValue);
            
            let matchesRegion = true;
            if (regionQuery) {
                // Find anything containing the map pin icon which is usually the address
                const regionEl = Array.from(card.querySelectorAll('p')).find(p => p.innerHTML.includes('ph-map-pin'));
                const cardRegion = regionEl ? regionEl.textContent.toLowerCase() : '';
                matchesRegion = cardRegion.includes(regionQuery);
            }

            card.style.display = (matchesSearch && matchesFilter && matchesRegion) ? 'block' : 'none';
        });
    };
    
    const regionSelect = document.getElementById('filter-region-followup');
    if (viewId === '#followup-view' && regionSelect) {
        regionSelect.addEventListener('change', applyFilters);
    }'''

content = content.replace(target, replacement)

target2 = '''    grid.innerHTML = '';

    const oneMonthAgo = new Date();'''

replacement2 = '''    grid.innerHTML = '';

    // Populate region filter
    const regionSelect = document.getElementById('filter-region-followup');
    if (regionSelect) {
        const currentVal = regionSelect.value;
        const uniqueRegions = [...new Set(members.map(m => m.address).filter(Boolean))].sort();
        regionSelect.innerHTML = '<option value="">كل المناطق</option>' + uniqueRegions.map(r => `<option value="${r}">${r}</option>`).join('');
        regionSelect.value = currentVal;
    }

    const oneMonthAgo = new Date();'''

content = content.replace(target2, replacement2)

with io.open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
