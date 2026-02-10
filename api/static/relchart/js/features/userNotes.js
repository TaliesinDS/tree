/**
 * User Notes feature — renders in the person detail panel's "User Notes" tab.
 *
 * - Loads notes from /user-notes?gramps_id=<id>
 * - Renders a list of notes with author + timestamp
 * - Allows users/admins to add, edit, and delete notes
 * - Guests see notes read-only (no add/edit/delete buttons)
 */

import * as api from '../api.js';
import { state } from '../state.js';

/**
 * Render the User Notes tab content into the given DOM container.
 *
 * @param {HTMLElement} container — the panel body element
 * @param {string} grampsId — the person's Gramps ID (survives re-imports)
 */
export async function renderUserNotesTab(container, grampsId) {
  if (!container) return;
  if (!grampsId) {
    container.innerHTML = '<div class="muted">No Gramps ID — notes require a Gramps ID.</div>';
    return;
  }

  container.innerHTML = '<div class="muted">Loading notes…</div>';

  try {
    const data = await api.fetchUserNotes(grampsId);
    const notes = Array.isArray(data?.results) ? data.results : [];
    _render(container, grampsId, notes);
  } catch (err) {
    container.innerHTML = `<div class="muted" style="color:var(--danger)">Failed to load notes: ${_esc(err.message)}</div>`;
  }
}

function _render(container, grampsId, notes) {
  const user = state.auth?.user;
  const canWrite = user && (user.role === 'admin' || user.role === 'user');

  let html = '';

  if (notes.length === 0) {
    html += '<div class="muted">No user notes yet.</div>';
  } else {
    html += '<ul class="userNotesList">';
    for (const n of notes) {
      const author = _esc(n.user_display_name || n.username || '?');
      const date = n.updated_at || n.created_at || '';
      const dateStr = date ? new Date(date).toLocaleString() : '';
      const isOwn = user && n.user_id === user.id;
      const canEdit = canWrite && (isOwn || user.role === 'admin');
      const orphan = n.orphaned ? ' <span style="color:var(--danger)" title="Person no longer exists in database">(orphaned)</span>' : '';

      html += `<li class="userNoteItem" data-note-id="${n.id}">
        <div class="userNoteMeta">${author}${orphan} · ${_esc(dateStr)}</div>
        <div class="userNoteBody" data-note-body="1">${_esc(n.body)}</div>
        ${canEdit ? `<div class="userNoteActions">
          <button type="button" data-action="edit" data-note-id="${n.id}">Edit</button>
          <button type="button" data-action="delete" data-note-id="${n.id}">Delete</button>
        </div>` : ''}
      </li>`;
    }
    html += '</ul>';
  }

  // Add note form (user/admin only).
  if (canWrite) {
    html += `<div class="userNoteAdd">
      <textarea data-note-input="1" placeholder="Add a note…"></textarea>
      <div class="userNoteAddBtns">
        <button type="button" class="miniToggle" data-action="save-new">Save</button>
      </div>
    </div>`;
  }

  container.innerHTML = html;

  // Wire action handlers.
  _wireActions(container, grampsId);
}

function _wireActions(container, grampsId) {
  // Save new note.
  const saveBtn = container.querySelector('[data-action="save-new"]');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const textarea = container.querySelector('[data-note-input="1"]');
      const body = (textarea?.value || '').trim();
      if (!body) return;
      saveBtn.disabled = true;
      try {
        await api.createUserNote(grampsId, body);
        await renderUserNotesTab(container, grampsId);
      } catch (err) {
        alert('Failed to save note: ' + err.message);
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // Edit buttons.
  for (const btn of container.querySelectorAll('[data-action="edit"]')) {
    btn.addEventListener('click', () => {
      const noteId = Number(btn.dataset.noteId);
      const li = container.querySelector(`[data-note-id="${noteId}"]`);
      if (!li) return;
      const bodyEl = li.querySelector('[data-note-body="1"]');
      if (!bodyEl) return;

      const currentText = bodyEl.textContent || '';
      bodyEl.innerHTML = `<textarea class="userNoteEditArea" style="width:100%;min-height:50px;font-size:12px;">${_esc(currentText)}</textarea>
        <div class="userNoteAddBtns" style="margin-top:4px;">
          <button type="button" class="miniToggle" data-action="save-edit" data-note-id="${noteId}">Save</button>
          <button type="button" class="miniToggle" data-action="cancel-edit">Cancel</button>
        </div>`;

      const saveEditBtn = bodyEl.querySelector('[data-action="save-edit"]');
      const cancelBtn = bodyEl.querySelector('[data-action="cancel-edit"]');

      cancelBtn?.addEventListener('click', () => renderUserNotesTab(container, grampsId));

      saveEditBtn?.addEventListener('click', async () => {
        const ta = bodyEl.querySelector('.userNoteEditArea');
        const newBody = (ta?.value || '').trim();
        if (!newBody) return;
        saveEditBtn.disabled = true;
        try {
          await api.updateUserNote(noteId, newBody);
          await renderUserNotesTab(container, grampsId);
        } catch (err) {
          alert('Failed to update note: ' + err.message);
        } finally {
          saveEditBtn.disabled = false;
        }
      });
    });
  }

  // Delete buttons.
  for (const btn of container.querySelectorAll('[data-action="delete"]')) {
    btn.addEventListener('click', async () => {
      const noteId = Number(btn.dataset.noteId);
      if (!confirm('Delete this note?')) return;
      btn.disabled = true;
      try {
        await api.deleteUserNote(noteId);
        await renderUserNotesTab(container, grampsId);
      } catch (err) {
        alert('Failed to delete note: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }
}

function _esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}
