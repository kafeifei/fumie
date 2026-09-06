# Mobile entry

This directory contains the experimental mobile entry point for the Fumie
workbench. It provides a small static boot page and server-side proxy hooks so
the browser can reach a compatible remote workbench without exposing provider
credentials to the page.

The entry point is still research software. Authentication, tunnel discovery,
reconnection, and browser compatibility depend on the upstream remote
workbench and are not promised as a stable public service. Deployment details,
account identifiers, tokens, production URLs, and local machine paths are kept
out of this document.

For local work, use placeholders and the repository's development scripts.
Never commit a token, an OAuth client secret, a deployment account, or a copied
production transcript.
