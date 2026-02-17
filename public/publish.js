(() => {
  const page = document.querySelector("[data-publish-page]");
  if (!page) return;

  const noteEl = page.querySelector("[data-publish-note]");
  const statusEl = page.querySelector("[data-publish-status]");
  const actionsEl = page.querySelector("[data-publish-actions]");
  const teamBoxEl = page.querySelector("[data-publish-team-box]");
  const teamNameEl = page.querySelector("[data-publish-team-name]");
  const teamLinkEl = page.querySelector("[data-publish-team-link]");
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

  const getSession = async () => {
    if (!window.BfangAuth || typeof window.BfangAuth.getSession !== "function") return null;
    return window.BfangAuth.getSession().catch(() => null);
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

  const renderLeaderRequests = async (teamId) => {
    if (!requestsWrap || !requestsList || !teamId) return;
    requestsWrap.hidden = false;
    requestsList.textContent = "Đang tải...";
    try {
      const data = await fetchJson(`/teams/${encodeURIComponent(String(teamId))}/requests?format=json`);
      const requests = Array.isArray(data.requests) ? data.requests : [];
      requestsList.textContent = "";
      if (!requests.length) {
        requestsList.textContent = "Không có yêu cầu đang chờ.";
        return;
      }

      requests.forEach((item) => {
        const row = document.createElement("div");
        row.className = "publish-request-item";
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

        row.querySelectorAll("button[data-request-action]").forEach((button) => {
          button.addEventListener("click", async () => {
            const action = button.getAttribute("data-request-action") || "";
            button.disabled = true;
            try {
              await fetchJson(
                `/teams/requests/${encodeURIComponent(String(teamId))}/${encodeURIComponent(item.userId)}/review?format=json`,
                {
                  method: "POST",
                  body: JSON.stringify({ action })
                }
              );
              row.remove();
              showStatus("Đã xử lý yêu cầu tham gia.", "success");
            } catch (error) {
              showStatus(error && error.message ? error.message : "Không thể xử lý yêu cầu.", "error");
            } finally {
              button.disabled = false;
            }
          });
        });

        requestsList.appendChild(row);
      });
    } catch (_error) {
      requestsWrap.hidden = true;
    }
  };

  const renderByTeamStatus = async () => {
    const session = await getSession();
    const signedIn = Boolean(session && session.user);
    if (!signedIn) {
      showStatus("Bạn cần đăng nhập để tạo hoặc tham gia nhóm dịch.", "error");
      if (actionsEl) actionsEl.hidden = false;
      if (teamBoxEl) teamBoxEl.hidden = true;
      if (requestsWrap) requestsWrap.hidden = true;
      return;
    }

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
        if (requestsWrap) requestsWrap.hidden = true;
        return;
      }

      if (actionsEl) actionsEl.hidden = true;
      if (noteEl) {
        noteEl.hidden = false;
        noteEl.textContent = `Bạn hiện thuộc nhóm dịch ${data.team.name || ""}.`;
      }
      if (teamBoxEl) teamBoxEl.hidden = false;
      if (teamNameEl) {
        const role = data.roleLabel ? ` (${data.roleLabel})` : "";
        teamNameEl.textContent = `${data.team.name || ""}${role}`;
      }
      if (teamLinkEl) {
        teamLinkEl.href = `/team/${encodeURIComponent(String(data.team.id))}/${encodeURIComponent(data.team.slug || "")}`;
      }

      if (data.team.role === "leader") {
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
          runSearch();
        }
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        if (joinDialog.open) joinDialog.close();
      });
    }
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

  setupJoinDialog();
  setupCreateDialog();
  renderByTeamStatus().catch(() => null);
})();
