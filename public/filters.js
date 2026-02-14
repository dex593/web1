const filterForm = document.querySelector(".filter-form--advanced");

if (filterForm) {
  const hiddenContainer = filterForm.querySelector("[data-filter-hidden]");
  const buttons = Array.from(filterForm.querySelectorAll(".filter-option--toggle"));
  const stateOrder = ["none", "include", "exclude"];

  const updateButton = (button, state) => {
    button.dataset.state = state;
    button.classList.remove("is-include", "is-exclude");
    if (state === "include") {
      button.classList.add("is-include");
    }
    if (state === "exclude") {
      button.classList.add("is-exclude");
    }
  };

  const syncHidden = () => {
    if (!hiddenContainer) return;
    hiddenContainer.innerHTML = "";
    buttons.forEach((button) => {
      const state = button.dataset.state || "none";
      if (state === "include" || state === "exclude") {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = state;
        input.value = button.dataset.genre || "";
        hiddenContainer.appendChild(input);
      }
    });
  };

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const current = button.dataset.state || "none";
      const index = stateOrder.indexOf(current);
      const next = stateOrder[(index + 1) % stateOrder.length];
      updateButton(button, next);
      syncHidden();
    });
  });

  syncHidden();
}
