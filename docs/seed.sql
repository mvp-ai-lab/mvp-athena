insert into users (id, github_login, github_email, display_name)
values ('dev-user', 'dev-user', 'dev-user@example.com', 'Dev User')
on conflict (id) do update set
  github_login = excluded.github_login,
  github_email = excluded.github_email,
  display_name = excluded.display_name;

insert into spaces (id, name, root_path, description)
values ('team', 'Team Knowledge', 'spaces/team', 'Default team knowledge space')
on conflict (id) do update set
  name = excluded.name,
  root_path = excluded.root_path,
  description = excluded.description;

insert into space_memberships (user_id, space_id, role)
values ('dev-user', 'team', 'owner')
on conflict (user_id, space_id) do update set
  role = excluded.role;
