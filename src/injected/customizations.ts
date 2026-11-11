let initialized = false;

function whenDomReady(callback: () => void) {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
        callback();
    }
}

export function applyCustomizations() {
    if (initialized) return;
    initialized = true;

    whenDomReady(() => {
        const style = document.createElement("style");
        style.textContent = `
            /* Override thin font weights in code blocks */
            [data-streamdown="code-block-body"] code span {
                font-weight: normal !important;
                font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace !important;
            }

            /* Improve code block overall readability */
            [data-streamdown="code-block-body"] {
                font-size: 14px !important;
                line-height: 1.6 !important;
                letter-spacing: 0.3px !important;
            }

            /* Make text more visible */
            [data-streamdown="code-block-body"] code span {
                opacity: 1 !important;
                color: inherit !important;
            }

            /* Better contrast for dark mode */
            .dark [data-streamdown="code-block-body"] code {
                background-color: #1e1e1e !important;
            }

            /* Improve light mode contrast */
            [data-streamdown="code-block-body"] code {
                background-color: #f5f5f5 !important;
            }
        `;
        (document.head ?? document.documentElement).appendChild(style);

        // Only add this if you actually need to react to new code blocks.
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (
                        node instanceof Element &&
                        node.getAttribute("data-streamdown") === "code-block"
                    ) {
                        // React to new code block here
                    }
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    });
}

