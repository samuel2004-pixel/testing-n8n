(function () {
  "use strict";
 
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const wrap = document.getElementById("wrap");
 
  // --- Helpers ---
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function initials(name) {
    if (!name) return "";
    return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("");
  }
  function fmtMoney(n, currency) {
    const abs = Math.abs(n || 0);
    return `${currency}${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d)) return iso;
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  }
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function statusLabel(s) {
    return { pending: "Pending", partially_paid: "Partially paid", paid: "Paid" }[s] || s;
  }
 
  function showError(msg) {
    wrap.innerHTML = `<div class="error-box"><h1>Link not found</h1><p>${escapeHtml(msg)}</p></div>`;
  }
 
  function toast(msg, type = 'info') {
    let t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      t.className = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = type === 'error' ? '#ef4444' : '#0f172a';
    t.classList.add("is-visible");
    setTimeout(() => t.classList.remove("is-visible"), 3000);
  }
 
  // --- Main Load ---
  async function load() {
    if (!token) return showError("This link is missing its account token. Ask for the link again.");
    let data, report;
    try {
      const [res, reportRes] = await Promise.all([
        fetch(`/api/portal/${token}`),
        fetch(`/api/portal/${token}/yearly-contributions`),
      ]);
      if (!res.ok) throw new Error("invalid");
      data = await res.json();
      // Yearly report drives the summary cards below (netted income minus
      // expense) — don't hard-fail the whole page if it's unavailable.
      report = reportRes.ok ? await reportRes.json() : null;
    } catch (e) {
      return showError("This link doesn't match any account. Ask for a fresh link.");
    }
    render(data, report);
    if (report) renderYearlyContribution(report);
  }
 
  let currentData = null;
  let currentReport = null;
 
  function render(data, report) {
    currentData = data;
    currentReport = report;
    // "Yearly Total" = the client's pledge/target for the year.
    // "Paid Amount" = what they've actually paid, already netted against
    // any same-month expenses (see /yearly-contributions on the backend).
    // Balance = what's still outstanding toward the yearly total.
    const yearlyTotal = report ? Number(report.yearlyTarget) || 0 : 0;
    const paidAmount = report ? Number(report.totalPaid) || 0 : 0;
    const balance = yearlyTotal - paidAmount;
    const avatarHtml = data.photo
      ? `<div class="avatar"><img src="${data.photo}" alt=""></div>`
      : `<div class="avatar">${escapeHtml(initials(data.name))}</div>`;
 
    const loansHtml = data.loans.length
      ? data.loans.map((l) => loanCardHtml(l, data.currency)).join("")
      : `<p class="empty-note">No loans on record.</p>`;
 
    const missingCount = ["phone", "email", "YWAM"].filter((k) => !data[k]).length;
    const editNudge = missingCount
      ? `<p class="profile-nudge">Your profile is missing some details. <button type="button" class="link-btn" id="editProfileBtn">Complete it</button></p>`
      : "";
 
    wrap.innerHTML = `
      <div class="header">
        ${avatarHtml}
        <div>
          <h1>${escapeHtml(data.name)}</h1>
          <p>${escapeHtml(data.company || "")}</p>
          ${data.YWAM ? `<p class="client-id-tag">YWAM Branch: ${escapeHtml(data.YWAM)}</p>` : ""}
          <p class="client-id-tag">MUT ID: ${escapeHtml(data.member_id || "—")}</p>
        </div>
        <button type="button" class="edit-link" id="editProfileBtnTop" title="Edit your profile">Edit profile</button>
      </div>
 
      ${editNudge}
 
      <div class="summary-row">
        <div class="summary-card"><span class="label">Yearly Total</span><span class="amt">${fmtMoney(yearlyTotal, data.currency)}</span></div>
        <div class="summary-card"><span class="label">Paid Amount</span><span class="amt">${fmtMoney(paidAmount, data.currency)}</span></div>
        <div class="summary-card balance"><span class="label">Balance</span><span class="amt ${balance > 0 ? "neg" : ""}">${fmtMoney(balance, data.currency)}</span></div>
      </div>
 
      <!-- NEW: PAYMENT PROOF UPLOAD SECTION -->
      <div class="panel upload-panel">
        <h2> Submit Payment Proof</h2>
        <p class="view-sub upload-sub">Upload a screenshot or photo of your payment. An admin will verify the amount via OCR and update your balance.</p>
 
        <form id="clientPaymentForm" class="upload-form">
          <label class="upload-label">
            <span>Amount Paid (${data.currency})</span>
            <input type="number" id="payAmount" name="amount" step="0.01" min="1" placeholder="0.00" required class="upload-input">
          </label>
 
          <label class="upload-label">
            <span>Upload Receipt / Screenshot</span>
            <input type="file" id="payReceipt" name="receipt" accept="image/*,application/pdf" required class="upload-file-input">
          </label>
 
          <button type="submit" id="submitPaymentBtn" class="upload-submit-btn">
            Submit for Verification
          </button>
        </form>
        <p id="clientPaymentMsg" class="upload-msg"></p>
      </div>
 
      <!-- NEW: IMPACT / MUT MEDICAL ASSISTANCE FORM -->
      <div class="panel upload-panel">
        <h2>PATIENT APPLICATION FORM</h2>
        <p class="view-sub upload-sub"></p>

        <form id="mutForm" class="upload-form mut-paper-form">
          <div class="mut-row">
            <label class="mut-row-label" for="mutName">NAME AS PER AADHAR CARD</label>
            <div class="mut-row-value"><input type="text" id="mutName" name="name" class="upload-input" value="${escapeHtml(data.name || "")}" required></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutFatherHusbandName">FATHER&rsquo;S NAME/ HUSBAND&rsquo;S NAME</label>
            <div class="mut-row-value"><input type="text" id="mutFatherHusbandName" name="fatherHusbandName" class="upload-input"></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutAge">AGE</label>
            <div class="mut-row-value"><input type="number" id="mutAge" name="age" min="0" class="upload-input"></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutGender">GENDER</label>
            <div class="mut-row-value">
              <select id="mutGender" name="gender" class="upload-input">
                <option value="">Select…</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Other">Other</option>
              </select>
            </div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutMaritalStatus">MARRIED/UNMARRIED</label>
            <div class="mut-row-value">
              <select id="mutMaritalStatus" name="maritalStatus" class="upload-input">
                <option value="">Select…</option>
                <option value="Married">Married</option>
                <option value="Unmarried">Unmarried</option>
              </select>
            </div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutOccupation">OCCUPATION OF THE APPLICANT</label>
            <div class="mut-row-value"><input type="text" id="mutOccupation" name="occupation" class="upload-input"></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutDob">DATE OF BIRTH</label>
            <div class="mut-row-value"><input type="date" id="mutDob" name="dob" class="upload-input"></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutId">IMPACT /MUT ID NUMBER</label>
            <div class="mut-row-value"><input type="text" id="mutId" name="mutId" class="upload-input" value="${escapeHtml(data.member_id || "")}"></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutHospitalNumber">HOSPITAL NUMBER OF CMCH</label>
            <div class="mut-row-value"><input type="text" id="mutHospitalNumber" name="hospitalNumber" class="upload-input"></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutCurrentAddress">CURRENT FIELD ADDRESS WITH PINCODE</label>
            <div class="mut-row-value"><textarea id="mutCurrentAddress" name="currentAddress" class="upload-input" rows="2"></textarea></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutAadhaarAddress">ADDRESS AS PER AADHAR CARD WITH PINCODE</label>
            <div class="mut-row-value"><textarea id="mutAadhaarAddress" name="aadhaarAddress" class="upload-input" rows="2"></textarea></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutAadhaarNumber">AADHAR CARD NUMBER</label>
            <div class="mut-row-value"><input type="text" id="mutAadhaarNumber" name="aadhaarNumber" class="upload-input"></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutAppointmentDate">TENTATIVE DATES OF APPOINTMENT</label>
            <div class="mut-row-value"><input type="date" id="mutAppointmentDate" name="appointmentDate" class="upload-input"></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutPersonalContact">PERSONAL CONTACT NUMBER</label>
            <div class="mut-row-value"><input type="tel" id="mutPersonalContact" name="personalContact" class="upload-input" value="${escapeHtml(data.phone || "")}"></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutPersonalEmail">PERSONAL E-MAIL ID</label>
            <div class="mut-row-value"><input type="email" id="mutPersonalEmail" name="personalEmail" class="upload-input" value="${escapeHtml(data.email || "")}"></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutOfficeContact">OFFICE CONTACT NUMBER</label>
            <div class="mut-row-value"><input type="tel" id="mutOfficeContact" name="officeContact" class="upload-input"></div>
          </div>
          <div class="mut-row">
            <label class="mut-row-label" for="mutIllnessNature">BRIEF NATURE OF ILLNESS</label>
            <div class="mut-row-value"><textarea id="mutIllnessNature" name="illnessNature" class="upload-input" rows="3"></textarea></div>
          </div>

          <button type="submit" id="submitMutBtn" class="upload-submit-btn">
            Submit Form
          </button>
        </form>
        <p id="mutFormMsg" class="upload-msg"></p>
      </div>
 
      <div class="panel" style="margin-top: 24px;">
        <h2>NOTE:</h2>
        ${loansHtml}
      </div>
 
      <p class="foot-note">This is your personal account link. Don't share it with anyone else.</p>
    `;
 
    // Initialize Event Listeners
    initPaymentUpload();
    initMutForm();
 
    const editBtnTop = document.getElementById("editProfileBtnTop");
    if (editBtnTop) editBtnTop.addEventListener("click", openProfileModal);
    const editNudgeBtn = document.getElementById("editProfileBtn");
    if (editNudgeBtn) editNudgeBtn.addEventListener("click", openProfileModal);
  }
 
  // ==========================================
  // CLIENT PAYMENT UPLOAD HANDLER
  // ==========================================
  function initPaymentUpload() {
    const form = document.getElementById('clientPaymentForm');
    if (!form) return;
 
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const amount = document.getElementById('payAmount').value;
      const receiptFile = document.getElementById('payReceipt').files[0];
      const msgEl = document.getElementById('clientPaymentMsg');
      const btn = document.getElementById('submitPaymentBtn');
 
      if (!amount || !receiptFile) {
        msgEl.innerText = '❌ Please fill in all fields and select a file.';
        msgEl.style.color = '#ef4444';
        return;
      }
 
      btn.disabled = true;
      btn.innerText = 'Processing (OCR)...';
      btn.style.opacity = '0.7';
      msgEl.innerText = 'Uploading and reading receipt...';
      msgEl.style.color = '#3b82f6';
 
      const formData = new FormData();
      formData.append('amount', amount);
      formData.append('receipt', receiptFile);
      // The backend will identify the client via the token in the URL or session
 
      try {
        // We use the token to identify the client on the backend
        const res = await fetch(`/api/client/upload-payment?token=${token}`, {
          method: 'POST',
          body: formData
        });
        
        const data = await res.json();
 
        if (data.success) {
          msgEl.innerText = '✅ ' + data.message;
          msgEl.style.color = '#16a34a';
          form.reset();
        } else {
          msgEl.innerText = '❌ ' + (data.error || 'Upload failed.');
          msgEl.style.color = '#ef4444';
        }
      } catch (err) {
        console.error('Upload error:', err);
        msgEl.innerText = '❌ Network error. Please try again.';
        msgEl.style.color = '#ef4444';
      } finally {
        btn.disabled = false;
        btn.innerText = 'Submit for Verification';
        btn.style.opacity = '1';
      }
    });
  }
 
  // ==========================================
  // IMPACT / MUT FORM HANDLER
  // ==========================================
  function initMutForm() {
    const form = document.getElementById('mutForm');
    if (!form) return;
 
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
 
      const msgEl = document.getElementById('mutFormMsg');
      const btn = document.getElementById('submitMutBtn');
 
      const payload = {
        name: document.getElementById('mutName').value.trim(),
        fatherHusbandName: document.getElementById('mutFatherHusbandName').value.trim(),
        age: document.getElementById('mutAge').value.trim(),
        gender: document.getElementById('mutGender').value,
        maritalStatus: document.getElementById('mutMaritalStatus').value,
        occupation: document.getElementById('mutOccupation').value.trim(),
        dob: document.getElementById('mutDob').value,
        mutId: document.getElementById('mutId').value.trim(),
        hospitalNumber: document.getElementById('mutHospitalNumber').value.trim(),
        currentAddress: document.getElementById('mutCurrentAddress').value.trim(),
        aadhaarAddress: document.getElementById('mutAadhaarAddress').value.trim(),
        aadhaarNumber: document.getElementById('mutAadhaarNumber').value.trim(),
        appointmentDate: document.getElementById('mutAppointmentDate').value,
        personalContact: document.getElementById('mutPersonalContact').value.trim(),
        personalEmail: document.getElementById('mutPersonalEmail').value.trim(),
        officeContact: document.getElementById('mutOfficeContact').value.trim(),
        illnessNature: document.getElementById('mutIllnessNature').value.trim(),
      };
 
      if (!payload.name) {
        msgEl.innerText = '❌ Please enter a name.';
        msgEl.style.color = '#ef4444';
        return;
      }
 
      btn.disabled = true;
      btn.innerText = 'Submitting…';
      btn.style.opacity = '0.7';
      msgEl.innerText = 'Submitting your form…';
      msgEl.style.color = '#3b82f6';
 
      try {
        const res = await fetch(`/api/portal/${token}/mut-form`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
 
        if (res.ok && data.ok) {
          msgEl.innerText = '✅ Form submitted. Thank you.';
          msgEl.style.color = '#16a34a';
          form.reset();
          // Restore the read-only prefill fields reset() just cleared.
          document.getElementById('mutName').value = payload.name;
          document.getElementById('mutId').value = payload.mutId;
          document.getElementById('mutPersonalContact').value = payload.personalContact;
          document.getElementById('mutPersonalEmail').value = payload.personalEmail;
        } else {
          msgEl.innerText = '❌ ' + (data.error || 'Submission failed.');
          msgEl.style.color = '#ef4444';
        }
      } catch (err) {
        console.error('MUT form submit error:', err);
        msgEl.innerText = '❌ Network error. Please try again.';
        msgEl.style.color = '#ef4444';
      } finally {
        btn.disabled = false;
        btn.innerText = 'Submit Form';
        btn.style.opacity = '1';
      }
    });
  }
 
  /* ---------- Edit profile modal (Existing Logic) ---------- */
  let pendingPhoto = undefined; 
 
  function openProfileModal() {
    pendingPhoto = undefined;
    const d = currentData || {};
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "profileModal";
    overlay.innerHTML = `
      <div class="modal">
        <h2>Your profile</h2>
        <p class="modal-sub">Keep your details up to date so reminders reach you.</p>
        <form id="profileForm">
          <div class="modal-photo-row">
            <div class="avatar avatar-lg" id="pPhotoPreview">${
              d.photo ? `<img src="${d.photo}" alt="">` : escapeHtml(initials(d.name))
            }</div>
            <div class="modal-photo-actions">
              <label class="btn-secondary" for="pPhoto">Change photo</label>
              <input type="file" id="pPhoto" accept="image/*" hidden>
              <button type="button" class="link-btn" id="pPhotoRemove" ${d.photo ? "" : "hidden"}>Remove</button>
            </div>
          </div>
 
          <label>Name<input type="text" id="pName" value="${escapeHtml(d.name || "")}" required></label>
          <label>Phone<input type="tel" id="pPhone" value="${escapeHtml(d.phone || "")}" placeholder="e.g. 98765 43210"></label>
          <label>Email<input type="email" id="pEmail" value="${escapeHtml(d.email || "")}"></label>
          <label>YWAM Branch<input type="text" id="pYWAM" value="${escapeHtml(d.YWAM || "")}"></label>
         
 
          <div class="modal-actions">
            <button type="button" class="btn-secondary" id="pCancel">Cancel</button>
            <button type="submit" class="btn" id="pSubmit">Save</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
 
    document.getElementById("pCancel").addEventListener("click", closeProfileModal);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeProfileModal(); });
 
    document.getElementById("pPhoto").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const size = 160;
          const canvas = document.createElement("canvas");
          canvas.width = size; canvas.height = size;
          const ctx = canvas.getContext("2d");
          const scale = Math.max(size / img.width, size / img.height);
          const w = img.width * scale, h = img.height * scale;
          ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          pendingPhoto = dataUrl;
          document.getElementById("pPhotoPreview").innerHTML = `<img src="${dataUrl}" alt="">`;
          document.getElementById("pPhotoRemove").hidden = false;
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
 
    document.getElementById("pPhotoRemove").addEventListener("click", () => {
      pendingPhoto = null;
      document.getElementById("pPhotoPreview").innerHTML = escapeHtml(initials(document.getElementById("pName").value));
      document.getElementById("pPhotoRemove").hidden = true;
    });
 
    document.getElementById("profileForm").addEventListener("submit", submitProfile);
  }
 
  function closeProfileModal() {
    const overlay = document.getElementById("profileModal");
    if (overlay) overlay.remove();
  }
 
  async function submitProfile(e) {
    e.preventDefault();
    const btn = document.getElementById("pSubmit");
    const name = document.getElementById("pName").value.trim();
    if (!name) return;
 
    const payload = {
      name,
      phone: document.getElementById("pPhone").value.trim(),
      email: document.getElementById("pEmail").value.trim(),
      YWAM: document.getElementById("pYWAM").value.trim(),
    };
    if (pendingPhoto !== undefined) payload.photo = pendingPhoto;
 
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const res = await fetch(`/api/portal/${token}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("failed");
      toast("Profile updated.");
      closeProfileModal();
      load();
    } catch (err) {
      toast("Could not save your profile. Please try again.");
      btn.disabled = false;
      btn.textContent = "Save";
    }
  }
 
  function loanCardHtml(l, currency) {
    const overdue = l.status !== "paid" && l.due_date < todayISO();
    const statusClass = overdue ? "overdue" : l.status;
    const statusText = overdue ? "Overdue" : statusLabel(l.status);
 
    // REMOVED OLD "I PAID THIS" FORM
    
    return `
      <div class="loan-card">
        <div class="loan-top">
          <span class="loan-amt">${fmtMoney(l.outstanding, currency)} <span style="font-size:12px; color:var(--ink-faint); font-weight:400;">of ${fmtMoney(l.amount, currency)}</span></span>
          <span class="status-pill ${statusClass}">${statusText}</span>
        </div>
        <div class="loan-due ${overdue ? "overdue" : ""}">Due ${fmtDate(l.due_date)}${l.description ? " · " + escapeHtml(l.description) : ""}</div>
      </div>
    `;
  }
function renderYearlyContribution(report) {
 
    try {
 
        const total = report.totalPaid;
 
        const html = `
        <div class="panel" style="margin-top:24px">
 
            <h2> Yearly Contributions (${report.year})</h2>
 
            <div class="table-scroll">
            <table class="yearly-table">
 
                <thead>
 
                    <tr>
 
                        <th>Jan</th>
                        <th>Feb</th>
                        <th>Mar</th>
                        <th>Apr</th>
                        <th>May</th>
                        <th>Jun</th>
                        <th>Jul</th>
                        <th>Aug</th>
                        <th>Sep</th>
                        <th>Oct</th>
                        <th>Nov</th>
                        <th>Dec</th>
                        <th>Total</th>
 
                    </tr>
 
                </thead>
 
                <tbody>
 
                    <tr>
 
                        <td>${report.monthly[1] || "-"}</td>
                        <td>${report.monthly[2] || "-"}</td>
                        <td>${report.monthly[3] || "-"}</td>
                        <td>${report.monthly[4] || "-"}</td>
                        <td>${report.monthly[5] || "-"}</td>
                        <td>${report.monthly[6] || "-"}</td>
                        <td>${report.monthly[7] || "-"}</td>
                        <td>${report.monthly[8] || "-"}</td>
                        <td>${report.monthly[9] || "-"}</td>
                        <td>${report.monthly[10] || "-"}</td>
                        <td>${report.monthly[11] || "-"}</td>
                        <td>${report.monthly[12] || "-"}</td>
 
                        <td><b>₹${total}</b></td>
 
                    </tr>
 
                </tbody>
 
            </table>
            </div>
 
            <br>
 
            <div style="display:flex;gap:20px;flex-wrap:wrap">
 
                <div>
                    <strong>Yearly Contribution</strong><br>
                    ₹${report.yearlyTarget}
                </div>
 
                <div>
                    <strong>Pending</strong><br>
                    ₹${report.pending}
                </div>
 
                <div>
                    <strong>Status</strong><br>
                    ${report.status}
                </div>
 
            </div>
 
        </div>
        `;
 
        const loansPanel = wrap.querySelector(".panel:last-of-type");
 
        loansPanel.insertAdjacentHTML("beforebegin", html);
 
    }
 
    catch(err){
 
        console.error(err);
 
    }
 
}
  load();
})();