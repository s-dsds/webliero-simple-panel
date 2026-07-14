#!/usr/bin/env node

// One-off migration: flat comments/<epochMs> -> sharded comments/<YYYYMMDD>/<epochMs>.
// Idempotent per entry: copy -> verify -> delete. Default dry-run; --commit to write/delete.
//
// Usage:
//   node migrate-comments.js --room cs_rere --creds /path/to/sa.json [--db https://liero-1t.firebaseio.com] [--commit]

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const BATCH_SIZE = 200;

function parseArgs(argv) {
    const args = {db: 'https://liero-1t.firebaseio.com', commit: false};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--room') args.room = argv[++i];
        else if (a === '--db') args.db = argv[++i];
        else if (a === '--creds') args.creds = argv[++i];
        else if (a === '--commit') args.commit = true;
        else throw new Error(`unknown argument: ${a}`);
    }
    if (!args.room) throw new Error('--room is required');
    if (!args.creds) throw new Error('--creds is required');
    return args;
}

function toDayBucket(epochMs) {
    return new Date(epochMs).toISOString().slice(0, 10).replace(/-/g, '');
}

function isFlatKey(key) {
    return /^\d{13}$/.test(key);
}

function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const creds = JSON.parse(fs.readFileSync(path.resolve(args.creds), 'utf8'));

    admin.initializeApp({
        credential: admin.credential.cert(creds),
        databaseURL: args.db
    });

    const db = admin.database();
    const commentsRef = db.ref(`simple/${args.room}/comments`);

    const snapshot = await commentsRef.once('value');
    const val = snapshot.val() || {};
    const flatKeys = Object.keys(val).filter(isFlatKey).sort();

    console.log(`room ${args.room}: found ${flatKeys.length} flat comment(s) to migrate`);
    if (!args.commit) {
        console.log('DRY RUN (pass --commit to apply). Planned moves:');
    }

    let moved = 0;
    let failed = 0;

    for (let i = 0; i < flatKeys.length; i += BATCH_SIZE) {
        const batch = flatKeys.slice(i, i + BATCH_SIZE);
        for (const epochMs of batch) {
            const entry = val[epochMs];
            const day = toDayBucket(Number(epochMs));
            console.log(`  ${epochMs} -> ${day}/${epochMs}`);

            if (!args.commit) {
                continue;
            }

            try {
                await commentsRef.child(day).child(epochMs).set(entry);
                const verifySnap = await commentsRef.child(day).child(epochMs).once('value');
                if (!deepEqual(verifySnap.val(), entry)) {
                    console.error(`  FAILED verify for ${epochMs}, leaving flat entry in place`);
                    failed++;
                    continue;
                }
                await commentsRef.child(epochMs).remove();
                moved++;
            } catch (e) {
                console.error(`  FAILED migrating ${epochMs}: ${e.message}`);
                failed++;
            }
        }
    }

    if (args.commit) {
        console.log(`done: moved ${moved}, failed ${failed}`);
    } else {
        console.log(`dry run complete: ${flatKeys.length} entr${flatKeys.length === 1 ? 'y' : 'ies'} would be moved`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
