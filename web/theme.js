(function () {
  "use strict";

  var storageKey = "mochizuki.theme";
  var systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  var chosenTheme = "";

  function validTheme(value) {
    return value === "dark" || value === "light" ? value : "";
  }

  try {
    chosenTheme = validTheme(window.localStorage.getItem(storageKey));
  } catch (error) {
    // Theme switching still works when browser storage is unavailable.
  }

  function applyTheme() {
    var theme = chosenTheme || (systemTheme.matches ? "dark" : "light");
    document.documentElement.dataset.theme = theme;
    var button = document.getElementById("themeToggleButton");
    if (!button) return;
    var label = theme === "dark" ? "ライトモードに切り替え" : "ダークモードに切り替え";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.querySelector("use").setAttribute("href", theme === "dark" ? "#icon-sun" : "#icon-moon");
  }

  // Apply the saved palette before the stylesheet paints the page.
  applyTheme();
  systemTheme.addEventListener("change", function () {
    if (!chosenTheme) applyTheme();
  });
  window.addEventListener("storage", function (event) {
    if (event.key !== storageKey && event.key !== null) return;
    chosenTheme = validTheme(event.newValue);
    applyTheme();
  });
  document.addEventListener("DOMContentLoaded", function () {
    applyTheme();
    var button = document.getElementById("themeToggleButton");
    if (!button) return;
    button.addEventListener("click", function () {
      chosenTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(storageKey, chosenTheme);
      } catch (error) {
        // Keep the selection for this page even if it cannot be persisted.
      }
      applyTheme();
    });
  });
}());
