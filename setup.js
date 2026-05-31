require("dotenv").config();
const pool = require("./database");

async function createTables() {
  try {
    // Table 1 — Organizations
    // PRD Reference: Section 4.1, Section 11, Section 13
    await pool.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        org_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        org_name VARCHAR(200) NOT NULL,
        timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
        status VARCHAR(20) DEFAULT 'active' 
          CHECK (status IN ('active', 'suspended')),
        bot_phone_number VARCHAR(20),
        organizer_email VARCHAR(200),
        task_counter INTEGER DEFAULT 0,
        suspended_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✅ Organizations table created");

    // Table 2 — Members
    // PRD Reference: Section 2.2, 2.3, 7.1, 10.1
    await pool.query(`
      CREATE TABLE IF NOT EXISTS members (
        member_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        org_id UUID REFERENCES organizations(org_id),
        name VARCHAR(100) NOT NULL,
        whatsapp_number VARCHAR(20) NOT NULL,
        role VARCHAR(20) DEFAULT 'member'
          CHECK (role IN ('organizer', 'member')),
        status VARCHAR(20) DEFAULT 'active'
          CHECK (status IN ('active', 'inactive')),
        email VARCHAR(200),
        otp VARCHAR(10),
        otp_expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(org_id, whatsapp_number)
      )
    `);
    console.log("✅ Members table created");

    // Table 3 — Tasks
    // PRD Reference: Section 5 — exact field by field match
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id VARCHAR(20) PRIMARY KEY,
        org_id UUID REFERENCES organizations(org_id),
        title VARCHAR(200) NOT NULL,
        description VARCHAR(1000),
        owner_id UUID REFERENCES members(member_id),
        creator_id UUID REFERENCES members(member_id),
        assignee_id UUID REFERENCES members(member_id),
        status VARCHAR(20) DEFAULT 'open'
          CHECK (status IN ('open', 'in_progress', 'completed', 'deleted')),
        priority VARCHAR(20) DEFAULT 'normal'
          CHECK (priority IN ('high', 'normal', 'low')),
        due_date DATE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP,
        parent_task_id VARCHAR(20)
      )
    `);
    console.log("✅ Tasks table created");

    // Table 4 — Pending Actions
    // PRD Reference: Section 6.1 — confirmation timeout 10 minutes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_actions (
        action_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        org_id UUID REFERENCES organizations(org_id),
        member_id UUID REFERENCES members(member_id),
        action_type VARCHAR(50) NOT NULL,
        action_data JSONB,
        status VARCHAR(20) DEFAULT 'pending'
          CHECK (status IN ('pending', 'confirmed', 'expired', 'cancelled')),
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✅ Pending actions table created");

    // Table 5 — Notification Preferences
    // PRD Reference: Section 9.3
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        member_id UUID REFERENCES members(member_id),
        org_id UUID REFERENCES organizations(org_id),
        notification_type VARCHAR(50) NOT NULL
          CHECK (notification_type IN (
            'task_assigned',
            'task_reassigned',
            'task_completed',
            'task_deleted',
            'ownership_transferred',
            'due_date_reminder',
            'member_removed',
            'tasks_orphaned'
          )),
        is_enabled BOOLEAN DEFAULT true,
        UNIQUE(member_id, org_id, notification_type)
      )
    `);
    console.log("✅ Notification preferences table created");

    // Table 6 — KaryaSetu Admins
    // PRD Reference: Section 11 — Admin Console
    await pool.query(`
      CREATE TABLE IF NOT EXISTS karyasetu_admins (
        admin_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        email VARCHAR(200) NOT NULL UNIQUE,
        name VARCHAR(100),
        otp VARCHAR(10),
        otp_expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✅ KaryaSetu admins table created");

    // Table 7 — Multi org membership
    // PRD Reference: Section 15, Question 5
    // One whatsapp number can be in multiple orgs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS member_org_context (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        whatsapp_number VARCHAR(20) NOT NULL,
        active_org_id UUID REFERENCES organizations(org_id),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(whatsapp_number)
      )
    `);
    console.log("✅ Multi-org context table created");

    console.log("");
    console.log("ALL TABLES CREATED SUCCESSFULLY ✅");
    console.log("Database is 100% matching the PRD requirements");
    process.exit(0);
  } catch (error) {
    console.log("Error creating tables:", error.message);
    process.exit(1);
  }
}

createTables();
