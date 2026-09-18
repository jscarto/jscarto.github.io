(function () {
  "use strict";

  var toggle = document.querySelector(".nav-toggle");
  var navList = document.getElementById("primary-nav");

  if (toggle && navList) {
    toggle.addEventListener("click", function () {
      var isOpen = navList.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
  }

  var copyBtn = document.querySelector("[data-copy-link]");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      var url = copyBtn.getAttribute("data-copy-link");
      var announce = function (msg) {
        var live = document.getElementById("copy-status");
        if (live) { live.textContent = msg; }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          announce("Link copied to clipboard");
        }, function () {
          announce("Could not copy link");
        });
      }
    });
  }
})();
