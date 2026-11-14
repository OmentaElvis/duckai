# [1.1.0](https://github.com/OmentaElvis/duckai/compare/v1.0.0...v1.1.0) (2026-11-14)


### Bug Fixes

* add a reload overlay and properly remove update banner ([1c43edd](https://github.com/OmentaElvis/duckai/commit/1c43eddb6fba5f7dba92c4897da8cef6c614d685))
* hookup loading animation ([b8378a9](https://github.com/OmentaElvis/duckai/commit/b8378a98116bea65ad84273fd417bac2b2eec572))
* mute reasoning logs ([89972e5](https://github.com/OmentaElvis/duckai/commit/89972e5356b19098370881208f544fc32019bf9b))


### Features

* add per chat harness toggle ([e5ce42a](https://github.com/OmentaElvis/duckai/commit/e5ce42a858a7cdcb8a24447a007068710dd25449))
* **harness:** reduce prompt footprint and block incompatible models ([193d977](https://github.com/OmentaElvis/duckai/commit/193d977c345bc77d8abc4d38d273424edd298b4b))

# 1.0.0 (2026-11-13)


### Bug Fixes

* add customization script for the duck.ai code block ([909cb2a](https://github.com/OmentaElvis/duckai/commit/909cb2af17c2bf6e09345ec6bd4b7220f6b3f275))
* bump max DEFAULT_MAX_LOOPS to 32 ([13cda0d](https://github.com/OmentaElvis/duckai/commit/13cda0d1860021d7ec3d35ef7e503b49900bcee8))
* remove echo from the registered prod tools ([e8a67ca](https://github.com/OmentaElvis/duckai/commit/e8a67cadef15bd3f7182b1997afa8844ce4b528b))
* terminate streaming the moment a tool call is detected ([38f75d3](https://github.com/OmentaElvis/duckai/commit/38f75d36435678c5a3e21532d0acfe07f06642b7))
* **worker:** replace blocking Atomics.wait bridge with async GTK poll ([17526f6](https://github.com/OmentaElvis/duckai/commit/17526f623950760a03912fda7430a49c4751bd55))


### Features

* add mcp_schema tool call ([e41a8a6](https://github.com/OmentaElvis/duckai/commit/e41a8a66aa08e6fe6a2da96de8b9a71461356e07))
* **approval-ui:** replace modal with inline prompt card and add execution safeguards ([13fcb24](https://github.com/OmentaElvis/duckai/commit/13fcb241a4777be9abbb2079b90d24f0e4da74df))
* **cache:** add offline mode and upstream update detection ([05fdf5e](https://github.com/OmentaElvis/duckai/commit/05fdf5ea80d12921117567d24d29650090c134ca))
* **ci:** wire up docker and gh actions ([a271eef](https://github.com/OmentaElvis/duckai/commit/a271eeffe3c3886e225d8f9f6509bb01cbbba104))
* initial commit ([7234a26](https://github.com/OmentaElvis/duckai/commit/7234a263617db12fe2761c85f14bec2b6b4b6ce5))
* **logging:** unify host and page logging ([e7d6584](https://github.com/OmentaElvis/duckai/commit/e7d6584d16a40de3061e4050cf1b02a3050bef9d))
* **mcp:** add lazy MCP client gateway with UI configuration ([b587780](https://github.com/OmentaElvis/duckai/commit/b5877802f696111dfd16ee5469046bb82c1cd467))
* **permissions:** add tool-driven granular scopes and explicit confirmation UI ([d377bcc](https://github.com/OmentaElvis/duckai/commit/d377bccb1e086cf7b2135fb159808fbb1e7b5a1f))
* **tools:** add bounded global memory for durable cross-session facts ([50c48ea](https://github.com/OmentaElvis/duckai/commit/50c48ea89e932d5d19fd72d58dc00c391ac979bd))
* **tools:** add modular core toolset, Unix-style listing, and rich views ([262c51f](https://github.com/OmentaElvis/duckai/commit/262c51fbd06727e8945e0b68bb7b91f12db07f90))
* **ui:** persist inline tool-call placement across reloads ([111d5db](https://github.com/OmentaElvis/duckai/commit/111d5db0c3a687e95a2904e756c009502a56c3ab))
