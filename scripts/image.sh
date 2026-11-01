#!/bin/sh
# Builds one of the repository's container images and publishes it with its OCI annotations.
#
# usage: scripts/image.sh build (web | gateway) <layout-dir> <revision> <created>
#        scripts/image.sh push <layout-dir> <revision> <created> <source> <run-url> (--oci-layout <dir> | <reference>)
#
# build writes the image to an OCI layout directory with podman: web
# packages the client's production build in packages/web/dist, which must
# hold the revision's revision.txt, with packages/web/image; gateway builds
# images/gateway. It refuses a worktree with changes or one not checked out
# at the revision.
# push writes that image's config and layers, annotated with the revision,
# source, run URL, creation time, and version, as one manifest: to another
# OCI layout with --oci-layout, or to a registry reference, reading the
# registry token on standard input. It prints the manifest digest. ORAS
# names the oras executable. Relative paths resolve against the caller's
# directory. See docs/web-client.md and docs/gateway.md.
set -eu

usage() {
	sed -n '4,5p' "$0" >&2
	exit 2
}

version=0.0.0
local_tag=qualified

caller=$PWD
absolute() {
	case "$1" in
	/*) printf '%s\n' "$1" ;;
	*) printf '%s/%s\n' "$caller" "$1" ;;
	esac
}

[ "$#" -ge 1 ] || usage
command=$1
shift
if [ "$command" = build ]; then
	[ "$#" -ge 1 ] || usage
	image=$1
	shift
fi
[ "$#" -ge 1 ] || usage
layout=$(absolute "$1")
shift
cd "$(dirname "$0")/.."

case "$command" in
build)
	[ "$#" -eq 2 ] || usage
	revision=$1 created=$2
	if [ -n "$(git status --porcelain)" ] || [ "$(git rev-parse HEAD)" != "$revision" ]; then
		echo "the image is built from a worktree without changes, checked out at $revision" >&2
		exit 1
	fi
	epoch=$(date -u -d "$created" +%s)
	context=$(mktemp -d)
	trap 'rm -r "$context"' EXIT
	case "$image" in
	web)
		if [ "$(cat packages/web/dist/revision.txt 2>/dev/null)" != "$revision" ]; then
			echo "packages/web/dist is not the web build of $revision; run bun run build:web" >&2
			exit 1
		fi
		cp packages/web/image/Containerfile packages/web/image/caddy.json "$context/"
		cp -R packages/web/dist "$context/site"
		;;
	gateway)
		cp images/gateway/Containerfile "$context/"
		;;
	*)
		usage
		;;
	esac
	tag="localhost/ashe-agent-$image-build:$revision"
	podman build --format oci --timestamp "$epoch" -t "$tag" "$context"
	podman save --format oci-dir -o "$layout" "$tag" >/dev/null
	podman rmi "$tag" >/dev/null
	;;
push)
	[ "$#" -ge 5 ] || usage
	revision=$1 created=$2 source=$3 run_url=$4
	shift 4
	: "${ORAS:?ORAS must name the oras executable}"
	manifest=$(jq -r '.manifests | if length == 1 then .[0].digest else error("one image expected") end' "$layout/index.json")
	blobs="$layout/blobs/sha256"
	config=$(jq -r '.config | "\(.digest | ltrimstr("sha256:")):\(.mediaType)"' "$blobs/${manifest#sha256:}")
	layers=$(jq -r '.layers[] | "\(.digest | ltrimstr("sha256:")):\(.mediaType)"' "$blobs/${manifest#sha256:}")
	case "$1" in
	--oci-layout)
		[ "$#" -eq 2 ] || usage
		destination=$(absolute "$2")
		set -- --oci-layout "$destination:$local_tag"
		;;
	*)
		[ "$#" -eq 1 ] || usage
		: "${ORAS_REGISTRY_CONFIG:?ORAS_REGISTRY_CONFIG must name a run-owned registry config file}"
		set -- -u oidc --password-stdin --registry-config "$ORAS_REGISTRY_CONFIG" "$1"
		;;
	esac
	cd "$blobs"
	# shellcheck disable=SC2086 # each layer is one word
	"$ORAS" push --format 'go-template={{.digest}}' --config "$config" \
		--annotation "org.opencontainers.image.created=$created" \
		--annotation "org.opencontainers.image.revision=$revision" \
		--annotation "org.opencontainers.image.source=$source" \
		--annotation "org.opencontainers.image.url=$run_url" \
		--annotation "org.opencontainers.image.version=$version" \
		"$@" $layers
	echo
	;;
*)
	usage
	;;
esac
