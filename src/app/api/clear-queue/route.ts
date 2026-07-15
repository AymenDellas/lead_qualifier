import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function POST() {
    try {
        const dirsToClear = [
            '/app/queue',
            '/app/queue-results',
            '/app/progress'
        ];

        let totalDeleted = 0;

        for (const dir of dirsToClear) {
            if (fs.existsSync(dir)) {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    if (file === '.' || file === '..') continue;
                    try {
                        const filePath = path.join(dir, file);
                        const stat = fs.statSync(filePath);
                        if (stat.isFile()) {
                            fs.unlinkSync(filePath);
                            totalDeleted++;
                        }
                    } catch (e) {
                        console.error(`Failed to delete ${file} in ${dir}:`, e);
                    }
                }
            }
        }

        return NextResponse.json({ success: true, deleted: totalDeleted, message: 'Queue cleared' });
    } catch (error: any) {
        return NextResponse.json({ error: error.message || 'Failed to clear queue' }, { status: 500 });
    }
}
