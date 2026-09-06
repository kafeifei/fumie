/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int parent_dir(char *path) {
	char *separator = strrchr(path, '/');
	if (separator == NULL || separator == path) {
		return 0;
	}
	*separator = '\0';
	return 1;
}

int main(void) {
	uint32_t size = 0;
	_NSGetExecutablePath(NULL, &size);
	char *executable = malloc(size);
	if (executable == NULL || _NSGetExecutablePath(executable, &size) != 0) {
		fprintf(stderr, "Fumie Debug: cannot resolve launcher path\n");
		return 1;
	}

	char resolved[PATH_MAX];
	if (realpath(executable, resolved) == NULL) {
		perror("Fumie Debug: realpath");
		free(executable);
		return 1;
	}
	free(executable);

	char contents[PATH_MAX];
	if (snprintf(contents, sizeof(contents), "%s", resolved) >= (int)sizeof(contents)) {
		fprintf(stderr, "Fumie Debug: launcher path is too long\n");
		return 1;
	}
	if (!parent_dir(contents) || !parent_dir(contents)) {
		fprintf(stderr, "Fumie Debug: cannot resolve bundle Contents directory\n");
		return 1;
	}

	char script[PATH_MAX];
	if (snprintf(script, sizeof(script), "%s/Resources/launch-fumie-debug.sh", contents) >= (int)sizeof(script)) {
		fprintf(stderr, "Fumie Debug: resource path is too long\n");
		return 1;
	}

	execl("/bin/bash", "bash", script, (char *)NULL);
	perror("Fumie Debug: launch script");
	return 1;
}
