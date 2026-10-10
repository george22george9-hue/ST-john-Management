import io
import re

filepath = r'c:\الكنيسة\خطة الأجتماع\برنامج الحضور\index.html'
with io.open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

new_ui = """<div id="perm-checkboxes" style="display: flex; flex-direction: column; gap: 10px; background: rgba(0,0,0,0.1); padding: 15px; border-radius: 8px;">
                    <div class="perm-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px;">
                        <span>الشاشة الرئيسية</span>
                        <select class="perm-select form-control" data-section="dashboard" style="width: 150px; padding: 5px;">
                            <option value="none">لا يوجد صلاحية</option>
                            <option value="view">مشاهدة فقط</option>
                        </select>
                    </div>
                    <div class="perm-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px;">
                        <span>تسجيل الحضور</span>
                        <select class="perm-select form-control" data-section="attendance" style="width: 150px; padding: 5px;">
                            <option value="none">لا يوجد صلاحية</option>
                            <option value="view">مشاهدة فقط</option>
                            <option value="edit">مشاهدة وتعديل</option>
                        </select>
                    </div>
                    <div class="perm-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px;">
                        <span>المتابعة والافتقاد</span>
                        <select class="perm-select form-control" data-section="followup" style="width: 150px; padding: 5px;">
                            <option value="none">لا يوجد صلاحية</option>
                            <option value="view">مشاهدة فقط</option>
                            <option value="edit">مشاهدة وتعديل</option>
                        </select>
                    </div>
                    <div class="perm-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px;">
                        <span>متابعة الخدام</span>
                        <select class="perm-select form-control" data-section="servants-dashboard" style="width: 150px; padding: 5px;">
                            <option value="none">لا يوجد صلاحية</option>
                            <option value="view">مشاهدة فقط</option>
                            <option value="edit">مشاهدة وتعديل</option>
                        </select>
                    </div>
                    <div class="perm-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px;">
                        <span>المسابقات</span>
                        <select class="perm-select form-control" data-section="competitions" style="width: 150px; padding: 5px;">
                            <option value="none">لا يوجد صلاحية</option>
                            <option value="view">مشاهدة فقط</option>
                            <option value="edit">مشاهدة وتعديل</option>
                        </select>
                    </div>
                    <div class="perm-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px;">
                        <span>الملخص</span>
                        <select class="perm-select form-control" data-section="summary" style="width: 150px; padding: 5px;">
                            <option value="none">لا يوجد صلاحية</option>
                            <option value="view">مشاهدة فقط</option>
                        </select>
                    </div>
                    <div class="perm-row" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px;">
                        <span>قاعدة البيانات (الإدارة)</span>
                        <select class="perm-select form-control" data-section="admin" style="width: 150px; padding: 5px;">
                            <option value="none">لا يوجد صلاحية</option>
                            <option value="view">مشاهدة فقط</option>
                            <option value="edit">مشاهدة وتعديل</option>
                        </select>
                    </div>
                    <div class="perm-row" style="display: flex; justify-content: space-between; align-items: center;">
                        <span>الإعدادات (خطر)</span>
                        <select class="perm-select form-control" data-section="settings" style="width: 150px; padding: 5px;">
                            <option value="none">لا يوجد صلاحية</option>
                            <option value="view">السماح بالدخول</option>
                        </select>
                    </div>
                </div>"""

pattern = r'<div id="perm-checkboxes"[^>]*>.*?</div>'
content = re.sub(pattern, new_ui, content, flags=re.DOTALL)

with io.open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
