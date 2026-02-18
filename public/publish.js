(() => {
  const page = document.querySelector("[data-publish-page]");
  if (!page) return;

  const noteEl = page.querySelector("[data-publish-note]");
  const statusEl = page.querySelector("[data-publish-status]");
  const actionsEl = page.querySelector("[data-publish-actions]");
  const teamBoxEl = page.querySelector("[data-publish-team-box]");
  const teamNameEl = page.querySelector("[data-publish-team-name]");
  const teamRoleEl = page.querySelector("[data-publish-team-role]");
  const teamSubEl = page.querySelector("[data-publish-team-sub]");
  const teamLinkEl = page.querySelector("[data-publish-team-link]");
  const manageLinkEl = page.querySelector("[data-publish-manage-link]");
  const requestsWrap = page.querySelector("[data-publish-requests]");
  const requestsList = page.querySelector("[data-publish-request-list]");

  const joinDialog = document.querySelector("[data-join-team-dialog]");
  const createDialog = document.querySelector("[data-create-team-dialog]");

  const showStatus = (message, tone = "") => {
    if (!statusEl) return;
    statusEl.hidden = !message;
    statusEl.textContent = message || "";
    statusEl.classList.remove("is-error", "is-success");
    if (tone === "error") statusEl.classList.add("is-error");
    if (tone === "success") statusEl.classList.add("is-success");
  };

  const fetchJson = async (url, options = {}) => {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {})
      },
      ...options
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) {
      throw new Error((data && data.error) || "Yêu cầu thất bại.");
    }
    return data;
  };

  const renderEmptyRequests = (message = "Không có yêu cầu đang chờ.") => {
    if (!requestsList) return;
    requestsList.textContent = "";
    const empty = document.createElement("p");
    empty.className = "publish-request-empty";
    empty.textContent = message;
    requestsList.appendChild(empty);
  };

  const attachRequestActions = (row, teamId, targetUserId) => {
    const safeTeamId = Number(teamId);
    const safeTargetUserId = (targetUserId || "").toString().trim();
    if (!row || !Number.isFinite(safeTeamId) || safeTeamId <= 0 || !safeTargetUserId) return;
    if (row.dataset.requestBound === "1") return;
    row.dataset.requestBound = "1";

    row.querySelectorAll("button[data-request-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.getAttribute("data-request-action") || "";
        button.disabled = true;
        try {
          await fetchJson(
            `/teams/requests/${encodeURIComponent(String(Math.floor(safeTeamId)))}/${encodeURIComponent(safeTargetUserId)}/review?format=json`,
            {
              method: "POST",
              body: JSON.stringify({ action })
            }
          );
          row.remove();
          showStatus("Đã xử lý yêu cầu tham gia.", "success");
          if (requestsList && !requestsList.querySelector("[data-request-user-id]")) {
            renderEmptyRequests();
          }
        } catch (error) {
          showStatus(error && error.message ? error.message : "Không thể xử lý yêu cầu.", "error");
        } finally {
          button.disabled = false;
        }
      });
    });
  };

  const hydrateExistingRequestRows = (teamId) => {
    if (!requestsList) return;
    const safeTeamId = Number(teamId);
    if (!Number.isFinite(safeTeamId) || safeTeamId <= 0) return;

    requestsList.querySelectorAll("[data-request-user-id]").forEach((row) => {
      const targetUserId = row.getAttribute("data-request-user-id") || "";
      attachRequestActions(row, safeTeamId, targetUserId);
    });
  };

  const renderLeaderRequests = async (teamId) => {
    const safeTeamId = Number(teamId);
    if (!requestsWrap || !requestsList || !Number.isFinite(safeTeamId) || safeTeamId <= 0) return;
    requestsWrap.hidden = false;
    const hasServerRenderedRows = Boolean(requestsList.querySelector("[data-request-user-id]"));
    const hasExistingText = Boolean((requestsList.textContent || "").trim());
    if (!hasServerRenderedRows && !hasExistingText) {
      requestsList.textContent = "Đang tải...";
    }

    try {
      const data = await fetchJson(`/teams/${encodeURIComponent(String(Math.floor(safeTeamId)))}/requests?format=json`);
      const requests = Array.isArray(data.requests) ? data.requests : [];
      requestsList.textContent = "";
      if (!requests.length) {
        renderEmptyRequests();
        return;
      }

      requests.forEach((item) => {
        const targetUserId = (item && item.userId ? String(item.userId) : "").trim();
        if (!targetUserId) return;
        const row = document.createElement("div");
        row.className = "publish-request-item";
        row.setAttribute("data-request-user-id", targetUserId);
        row.innerHTML = `
          <div>
            <strong>${item.displayName || (item.username ? `@${item.username}` : "Thành viên")}</strong>
            <p class="note">${item.username ? `@${item.username}` : ""}</p>
          </div>
          <div class="publish-request-item__actions">
            <button class="button" type="button" data-request-action="approve">Duyệt</button>
            <button class="button button--ghost" type="button" data-request-action="reject">Từ chối</button>
          </div>
        `;
        attachRequestActions(row, safeTeamId, targetUserId);
        requestsList.appendChild(row);
      });
    } catch (_error) {
      if (!hasServerRenderedRows && !hasExistingText) {
        renderEmptyRequests("Không thể tải yêu cầu đang chờ.");
      }
    }
  };

  const renderByTeamStatus = async () => {
    try {
      const data = await fetchJson("/account/team-status?format=json");
      const inTeam = Boolean(data.inTeam && data.team);

      if (!inTeam) {
        if (noteEl) {
          noteEl.hidden = false;
          noteEl.textContent = "Để có quyền đăng truyện, bạn phải là thành viên của một nhóm dịch.";
        }
        if (actionsEl) actionsEl.hidden = false;
        if (teamBoxEl) teamBoxEl.hidden = true;
        if (teamRoleEl) {
          teamRoleEl.hidden = true;
          teamRoleEl.textContent = "";
          teamRoleEl.classList.remove("is-leader", "is-member");
        }
        if (teamSubEl) {
          teamSubEl.hidden = true;
          teamSubEl.textContent = "";
        }
        if (manageLinkEl) {
          manageLinkEl.hidden = true;
          manageLinkEl.setAttribute("href", "#");
        }
        if (requestsWrap) requestsWrap.hidden = true;
        return;
      }

      if (actionsEl) actionsEl.hidden = true;
      if (noteEl) {
        noteEl.hidden = false;
        noteEl.textContent = "Bạn đã có quyền đăng truyện. Quản lý nhóm và yêu cầu tham gia bên dưới.";
      }
      if (teamBoxEl) teamBoxEl.hidden = false;
      if (teamNameEl) {
        teamNameEl.textContent = data.team.name || "";
      }
      if (teamRoleEl) {
        const role = (data.team.role || "member").toString().trim().toLowerCase();
        teamRoleEl.hidden = false;
        teamRoleEl.textContent = role === "leader" ? "Leader" : "Member";
        teamRoleEl.classList.toggle("is-leader", role === "leader");
        teamRoleEl.classList.toggle("is-member", role !== "leader");
      }
      if (teamSubEl) {
        const roleLabel = (data.roleLabel || "").toString().trim();
        teamSubEl.hidden = !roleLabel;
        teamSubEl.textContent = roleLabel;
      }
      if (teamLinkEl) {
        teamLinkEl.href = `/team/${encodeURIComponent(String(data.team.id))}/${encodeURIComponent(data.team.slug || "")}`;
      }

      if (manageLinkEl) {
        const manageMangaUrl = (data.manageMangaUrl || "").toString().trim();
        if (manageMangaUrl) {
          manageLinkEl.hidden = false;
          manageLinkEl.href = manageMangaUrl;
        } else {
          manageLinkEl.hidden = true;
          manageLinkEl.setAttribute("href", "#");
        }
      }

      if (data.team.role === "leader") {
        hydrateExistingRequestRows(data.team.id);
        await renderLeaderRequests(data.team.id);
      } else if (requestsWrap) {
        requestsWrap.hidden = true;
      }
    } catch (error) {
      showStatus(error && error.message ? error.message : "Không thể tải trạng thái nhóm dịch.", "error");
    }
  };

  const setupJoinDialog = () => {
    if (!joinDialog) return;
    const openBtn = page.querySelector("[data-open-join-team]");
    const closeBtn = joinDialog.querySelector("[data-close-join-team]");
    const searchInput = joinDialog.querySelector("[data-join-team-search]");
    const resultsEl = joinDialog.querySelector("[data-join-team-results]");
    let timer = null;

    const clearResults = () => {
      if (!resultsEl) return;
      resultsEl.textContent = "";
    };

    const renderResults = (teams) => {
      if (!resultsEl) return;
      resultsEl.textContent = "";
      if (!Array.isArray(teams) || !teams.length) {
        resultsEl.textContent = "Không tìm thấy nhóm dịch phù hợp.";
        return;
      }

      teams.forEach((item) => {
        const row = document.createElement("div");
        row.className = "publish-search-item";
        row.innerHTML = `
          <div>
            <strong>${item.name || "Nhóm dịch"}</strong>
            <p class="note">/${item.slug || ""}</p>
          </div>
          <button class="button" type="button">Tham gia</button>
        `;
        const button = row.querySelector("button");
        if (button) {
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              await fetchJson("/teams/join-request?format=json", {
                method: "POST",
                body: JSON.stringify({ teamId: item.id })
              });
              showStatus(`Đã gửi yêu cầu tham gia ${item.name || "nhóm dịch"}.`, "success");
              joinDialog.close();
            } catch (error) {
              showStatus(error && error.message ? error.message : "Không thể gửi yêu cầu tham gia.", "error");
            } finally {
              button.disabled = false;
            }
          });
        }
        resultsEl.appendChild(row);
      });
    };

    const runSearch = async () => {
      if (!resultsEl || !searchInput) return;
      const query = String(searchInput.value || "").trim();
      if (!query) {
        clearResults();
        return;
      }
      resultsEl.textContent = "Đang tìm...";
      try {
        const data = await fetchJson(`/teams/search?format=json&q=${encodeURIComponent(query)}`);
        renderResults(data.teams || []);
      } catch (_error) {
        resultsEl.textContent = "Không thể tải danh sách nhóm dịch.";
      }
    };

    if (searchInput) {
      searchInput.addEventListener("input", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(runSearch, 220);
      });
    }

    if (openBtn) {
      openBtn.addEventListener("click", () => {
        if (typeof joinDialog.showModal === "function") {
          joinDialog.showModal();
          clearResults();
          if (searchInput) {
            searchInput.value = "";
            searchInput.focus();
          }
        }
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        if (joinDialog.open) joinDialog.close();
      });
    }

    joinDialog.addEventListener("close", () => {
      clearResults();
      if (searchInput) {
        searchInput.value = "";
      }
    });
  };

  const setupCreateDialog = () => {
    if (!createDialog) return;
    const openBtn = page.querySelector("[data-open-create-team]");
    const closeBtn = createDialog.querySelector("[data-close-create-team]");
    const form = createDialog.querySelector("[data-create-team-form]");
    const status = createDialog.querySelector("[data-create-team-status]");

    const setFormStatus = (message, tone = "") => {
      if (!status) return;
      status.hidden = !message;
      status.textContent = message || "";
      status.classList.remove("is-error", "is-success");
      if (tone === "error") status.classList.add("is-error");
      if (tone === "success") status.classList.add("is-success");
    };

    if (openBtn) {
      openBtn.addEventListener("click", () => {
        if (typeof createDialog.showModal === "function") {
          createDialog.showModal();
        }
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        if (createDialog.open) createDialog.close();
      });
    }

    if (form) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        setFormStatus("");
        const payload = {
          name: form.querySelector("[data-create-team-name]")?.value || "",
          facebookUrl: form.querySelector("[data-create-team-facebook]")?.value || "",
          discordUrl: form.querySelector("[data-create-team-discord]")?.value || "",
          intro: form.querySelector("[data-create-team-intro]")?.value || ""
        };

        const submitButton = form.querySelector("button[type='submit']");
        if (submitButton) submitButton.disabled = true;
        try {
          const data = await fetchJson("/teams/create?format=json", {
            method: "POST",
            body: JSON.stringify(payload)
          });
          setFormStatus("Đã gửi yêu cầu tạo nhóm. Admin sẽ duyệt trong trang quản trị.", "success");
          if (data && data.team && data.team.url) {
            showStatus("Tạo nhóm thành công. Chờ admin duyệt trước khi hiển thị công khai.", "success");
          }
          renderByTeamStatus().catch(() => null);
        } catch (error) {
          setFormStatus(error && error.message ? error.message : "Không thể tạo nhóm dịch.", "error");
        } finally {
          if (submitButton) submitButton.disabled = false;
        }
      });
    }
  };

  const hydrateInitialLeaderRows = () => {
    if (!requestsWrap || requestsWrap.hidden) return;
    if (!teamLinkEl) return;

    const href = (teamLinkEl.getAttribute("href") || "").toString().trim();
    const match = /^\/team\/(\d+)\//.exec(href);
    if (!match) return;

    const teamId = Number(match[1]);
    if (!Number.isFinite(teamId) || teamId <= 0) return;
    hydrateExistingRequestRows(Math.floor(teamId));
  };

  setupJoinDialog();
  setupCreateDialog();
  hydrateInitialLeaderRows();
  renderByTeamStatus().catch(() => null);
})();
