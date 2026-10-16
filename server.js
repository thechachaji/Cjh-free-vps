const express = require('express');
const session = require('express-session');
const Docker = require('dockerode');
const http = require('http');
const os = require('os');

const app = express();
const server = http.createServer(app);
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'vps-panel-secret-key',
    resave: false,
    saveUninitialized: true
}));

// In-memory user database & active VMs
const users = []; // { username, password }
const activeVMs = {}; // username -> { containerId, name, expiry }

// Helper to get local IP
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

// Routes
app.get('/', (req, res) => {
    if (!req.session.user) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>Login - Free VPS Panel</title><style>body{font-family:Arial;background:#111;color:#fff;text-align:center;padding-top:50px;}input{padding:10px;margin:5px;width:200px;}button{padding:10px 20px;background:#28a745;color:#fff;border:none;cursor:pointer;}</style></head>
            <body>
                <h2>Free VPS Panel Login</h2>
                <form action="/login" method="POST">
                    <input type="text" name="username" placeholder="Username" required><br>
                    <input type="password" name="password" placeholder="Password" required><br>
                    <button type="submit">Login</button>
                </form>
                <p>Don't have an account? <a href="/register" style="color:#28a745;">Register</a></p>
            </body>
            </html>
        `);
    }

    const user = req.session.user;
    const vm = activeVMs[user];

    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Dashboard - Free VPS Panel</title><style>body{font-family:Arial;background:#111;color:#fff;text-align:center;padding-top:30px;}button{padding:10px 20px;background:#dc3545;color:#fff;border:none;cursor:pointer;} .btn-create{background:#28a745;}</style></head>
        <body>
            <h1>Welcome, ${user}</h1>
            <p><a href="/logout" style="color:#ff4444;">Logout</a></p>
            <hr style="width:50%;margin:20px auto;">
            ${vm ? `
                <div style="background:#222;padding:20px;display:inline-block;border-radius:5px;">
                    <h3>Your Active VM: ${vm.name}</h3>
                    <p>Status: Running (1 Hour Limit)</p>
                    <p>Container ID: ${vm.containerId.substring(0, 12)}</p>
                    <button onclick="location.href='/delete-vm'">Delete VM</button>
                </div>
            ` : `
                <form action="/create-vm" method="POST">
                    <h3>Create Your First VM</h3>
                    <input type="text" name="vmname" placeholder="Enter VM Name" required style="padding:10px;width:200px;"><br><br>
                    <button type="submit" class="btn-create">CREATE my fast vm</button>
                </form>
            `}
        </body>
        </html>
    `);
});

app.get('/register', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Register - Free VPS Panel</title><style>body{font-family:Arial;background:#111;color:#fff;text-align:center;padding-top:50px;}input{padding:10px;margin:5px;width:200px;}button{padding:10px 20px;background:#007bff;color:#fff;border:none;cursor:pointer;}</style></head>
        <body>
            <h2>Register New Account</h2>
            <form action="/register" method="POST">
                <input type="text" name="username" placeholder="Username" required><br>
                <input type="password" name="password" placeholder="Password" required><br>
                <button type="submit">Register</button>
            </form>
            <p>Already have an account? <a href="/" style="color:#007bff;">Login</a></p>
        </body>
        </html>
    `);
});

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) {
        return res.send('User already exists! <a href="/register">Back</a>');
    }
    users.push({ username, password });
    res.redirect('/');
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (!user) {
        return res.send('Invalid credentials! <a href="/">Back</a>');
    }
    req.session.user = username;
    res.redirect('/');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Create VM (Docker Container with 1-hour expiry)
app.post('/create-vm', async (req, res) => {
    if (!req.session.user) return res.redirect('/');
    const user = req.session.user;

    if (activeVMs[user]) {
        return res.send('Aap sirf ek hi VM create kar sakte hain! <a href="/">Back</a>');
    }

    const vmname = req.body.vmname || 'my-vm';

    try {
        // Pull ubuntu image and run container
        await docker.pull('ubuntu:latest');
        const container = await docker.createContainer({
            Image: 'ubuntu:latest',
            Cmd: ['/bin/sleep', '3600'], // Runs for 1 hour then stops
            Tty: true,
            name: `vps_${user}_${Date.now()}`
        });

        await container.start();
        const containerInfo = await container.inspect();

        activeVMs[user] = {
            containerId: containerInfo.Id,
            name: vmname
        };

        // Auto delete after 1 hour (3600000 ms)
        setTimeout(async () => {
            if (activeVMs[user] && activeVMs[user].containerId === containerInfo.Id) {
                try {
                    await container.stop();
                    await container.remove();
                } catch (e) {}
                delete activeVMs[user];
            }
        }, 3600000);

        res.redirect('/');
    } catch (err) {
        res.send('Error creating VM: ' + err.message + ' <a href="/">Back</a>');
    }
});

// Delete VM manually
app.get('/delete-vm', async (req, res) => {
    if (!req.session.user) return res.redirect('/');
    const user = req.session.user;
    const vm = activeVMs[user];

    if (vm) {
        try {
            const container = docker.getContainer(vm.containerId);
            await container.stop();
            await container.remove();
        } catch (e) {}
        delete activeVMs[user];
    }
    res.redirect('/');
});

const PORT = 6767;
server.listen(PORT, () => {
    const ip = getLocalIP();
    console.log(`Panel successfully installed and running!`);
    console.log(`Localhost Link: http://localhost:${PORT}`);
    console.log(`IP Link: http://${ip}:${PORT}`);
});
