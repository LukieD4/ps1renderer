/**
 * ============================================================================
 * project.js
 *
 * JSON Project Serialization for .PaletteGen files
 * ============================================================================
 */

(function (global) {

    "use strict";

    /**
     * Saves the entire state of the PaletteManager into a text file.
     * Reuses the source image's base filename so the saved project is
     * easy to associate with the asset it came from.
     */
    function saveProject(manager) {

        if (!manager) return;

        const payload = JSON.stringify(manager.toJSON(), null, 4);
        const blob = new Blob([payload], { type: "application/json" });
        const url = URL.createObjectURL(blob);

        const baseName = manager.getBaseFileName ? manager.getBaseFileName() : "palette-workspace";

        const a = document.createElement("a");
        a.href = url;
        a.download = `${baseName}.PaletteGen`;

        document.body.appendChild(a);
        a.click();

        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    }

    /**
     * Loads a file, passes data to the manager, and fires a completion event.
     */
    function loadProject(file, manager, onComplete) {

        if (!file || !manager) return;

        const reader = new FileReader();

        reader.onload = function (e) {

            try {

                const data = JSON.parse(e.target.result);
                manager.fromJSON(data);
                if (onComplete) onComplete();

            } catch (err) {

                alert("Failed to parse project file: Invalid .PaletteGen schema.");
                console.error(err);

            }

        };

        reader.readAsText(file);

    }

    global.PaletteProject = {
        saveProject,
        loadProject
    };

})(window);