import * as balenaSdk from 'balena-sdk';
import * as bSemver from 'balena-semver';

const UUID = ((process.env.UUID as unknown) as string) ?? undefined;
const TOKEN = ((process.env.TOKEN as unknown) as string) ?? undefined;
const RANDOM = ((process.env.RANDOM_ORDER as unknown) as boolean) ?? false;
const STAGING = ((process.env.STAGING as unknown) as boolean) || true;
const STEP = ((process.env.STEP as unknown) as number) ?? 1;
const maxFails = ((process.env.MAX_FAILS as unknown) as number) || 10;

if (!TOKEN) {
	console.error('TOKEN required in environment');
	process.exit(1);
}

balenaSdk.setSharedOptions({
	dataDirectory: '/tmp/work',
	apiUrl: `https://api.${STAGING ? 'balena-staging' : 'balena-cloud'}.com`,
 })

// TODO: better way to source these? flags?
const balena = balenaSdk.fromSharedOptions();

balena.auth.loginWithToken(TOKEN).then(() => {
	balena.auth.isLoggedIn().then((isLoggedIn: boolean) => {
		if (!isLoggedIn) {
			throw new Error('Authentication Error');
		}
	});
});

enum HUPStatus {
	IN_PROGRESS = 'in_progress',
	DONE = 'done',
	ERROR = 'error',
}

const delay = (ms: number) => {
	return new Promise( resolve => setTimeout(resolve, ms) );
}

const getDeviceType = async (uuid: string): Promise<string> => {
	return await balena.models.device.get(uuid).then((device) => {
		return device.device_type
	});
};


const getDeviceVersion = async (uuid: string): Promise<string> => {
	return await balena.models.device.get(uuid).then(async (device) => {
		return balena.models.device.getOsVersion(device)
	});
};

const getNextTargetVersion = async (
	deviceType: string,
	osVersion: string,
): Promise<string | null> => {
	return await balena.models.os
		.getSupportedOsUpdateVersions(deviceType, osVersion)
		.then((versions) => {
			if (versions.versions.length > 1) {
				return RANDOM
					? versions.versions[
							Math.floor(Math.random() * versions.versions.length)
					  ]
					: versions.versions[versions.versions.length - (2 * STEP)];
			} else {
				return null;
			}
		});
};

const ongoingHUP = async (uuid: string): Promise<boolean> => {
	const hupStatus = await balena.models.device.getOsUpdateStatus(uuid);
	return hupStatus.status === HUPStatus.IN_PROGRESS;
};

const hupFailed = async (uuid: string, targetOS: string): Promise<boolean> => {
	try {
		const hupStatus = await balena.models.device.getOsUpdateStatus(UUID);
		if (hupStatus.status === HUPStatus.ERROR || hupStatus.fatal === true) {
			return true;
		} else if (hupStatus.status === HUPStatus.DONE) {
			const osVersion = await getDeviceVersion(uuid);
			if (bSemver.gt(targetOS, osVersion)) {
				console.log(`HUP done but not completed: target ${targetOS}, current: ${osVersion}`);
				return true;
			}
		}
	} catch (e) {
		console.error(`error while getting status: ${e}`)
	}
	return false;
};

const main = async () => {
	// send the hup
	// 	wait for the hup to finish
	// 	wait for device to update
	// 	might need to send reboots
	// 	if the HUP errors, bail (or maybe just retry?)
	// 	if the target isn't reached, bail
	// get the device
	if (!UUID) {
		console.error('UUID required in environment');
		process.exit(1);
	}
	let fails = 0;
	const deviceType = await getDeviceType(UUID);
	while (fails <= maxFails) {
		let localFails = 0;
		while (await ongoingHUP(UUID) && localFails < maxFails) {
			console.log('HUP ongoing...');
			await delay(60000);
			localFails++;
		}
		while (! await balena.models.device.isOnline(UUID) && localFails < maxFails) {
			console.log('Waiting for device to connect...');
			await delay(60000);
			localFails++;
		}
		if (localFails >= maxFails) {
			console.log(`HUP ladder failed, device did not complete or come back`);
			process.exit(1)
		}
		const osVersion = await getDeviceVersion(UUID);
		const targetOS = await getNextTargetVersion(deviceType, osVersion);
		if (!targetOS) {
			console.log('HUP ladder completed');
			process.exit(0);
		} else {
			console.log(`Updating ${UUID} to ${targetOS}..`);
			try {
				balena.models.device.startOsUpdate(UUID, targetOS);
			} catch (e) {
				console.error(`error while starting update: ${e}`)
			}
			console.log(`Giving it a minute..`);
			await delay(60000);
			if (await hupFailed(UUID, targetOS)) {
				fails++;
				console.error(`HUP failed, retrying (failures: ${fails}/${maxFails})...`);
			}
		}
	}
	console.error(`HUP ladder exceeded error budget of ${maxFails}`);
	process.exit(1);
};

console.log('starting HUP ladder...');
main();
