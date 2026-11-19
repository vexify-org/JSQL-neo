# ✨ Contributors to JSQL-neo

Thank you to everyone who has contributed to making JSQL-neo better!
This project thrives because of the open-source community and tireless automation.

## 🌟 Core Maintainers
* **vexify-root** (Vexify) - Creator & Lead Architect

## 👑 Core Area Maintainers
* **[aqeelat](https://github.com/aqeelat)** - **MongoDB Module Lead & Core Contributor**
  - Responsible for auditing, optimizing, and maintaining the MongoDB wire-protocol compatibility layer and query engine.
  - 🛡️ **MongoDB Persistence Fix**: Prevented schemaless collections from persisting as 4-byte stubs and reloading empty.
  - 🐞 **Critical Bug Fix (#107)**: Fixed `ObjectId` coercion to String that caused twin `_id`s to collide and documents to be silently dropped.
  - 🔧 **Legacy Compat Fix**: Fixed a missing `require('fs')` that prevented the legacy single-file compatibility path from ever running.
  - *Veteran Developer (13+ years on GitHub)*

## 🤖 Automated Agents & Bots
* **[vexify-build](https://github.com/vexify-build) (Vbot)** - *Chief Grunt Work Officer & Issue Spammer*
  - 🧹 **The Ultimate Janitor**: Automatically generates detailed issues, updates documentation, and handles all the tedious boilerplate.
  - 🛡️ **The "Safe Zone" Operative**: Voluntarily restricted from touching the core Rust engine. Why? Because if an AI hallucinates a memory leak in the `unsafe` block, the whole server goes down. We don't let Vbot near the B-Tree.
  - 🚀 **Deployment Machine**: Automates CI/CD pipelines, test runs, and OIDC signed releases 24/7.

## 🚀 Hero Contributors

* **[IG-ABHINAV](https://github.com/IG-ABHINAV)** - *First-time contributor*
  - 🛠 **Math Functions (#117)**: Implemented 15 missing scalar functions (`LOG`, `LN`, `EXP`, `trig`, `DEGREES`, `RADIANS`, `COT`).
  - 🧪 **Testing**: Added 54 comprehensive regression test cases.
  - 🔍 **Quality Assurance**: Discovered the missing `PI()` implementation.

---
*Want to see your name here? Check out our open issues and submit a PR! (Humans only, Vbot already took all the easy ones.)*
